package backend

import (
	"bytes"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"hash/crc32"
	"image"
	"image/color"
	"image/draw"
	"image/gif"
	"image/jpeg"
	"image/png"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
)

const (
	imageGPSMarker     = "fixture-private-gps"
	imageCommentMarker = "fixture-private-comment"
)

func TestImageAnalysisSendsVisualCopiesWithoutMetadata(t *testing.T) {
	app, base := testBackend(t)
	app.Config.ImageAnalysisEnabled = true
	user := imageTestAccount(t, app, base, "visual-copy")
	enableImageTestAccount(user)
	setImageTestBudget(user, 1, 10000, 10000)
	objects, _, storage := newUploadStorageFixture(t)
	app.Assets = storage
	owner := user.do("GET", "/auth/session", nil, "").want(t, 200)["user"].(map[string]any)["id"].(string)
	requests := make(chan []byte, 8)
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var request struct {
			MaxTokens int `json:"max_tokens"`
			Messages  []struct {
				Content []struct {
					ImageURL *struct{ URL string } `json:"image_url"`
				} `json:"content"`
			} `json:"messages"`
		}
		err := json.NewDecoder(r.Body).Decode(&request)
		if err != nil || request.MaxTokens != 512 || len(request.Messages) != 1 ||
			len(request.Messages[0].Content) != 2 || request.Messages[0].Content[1].ImageURL == nil {
			t.Error("invalid visual model payload")
			w.WriteHeader(400)
			return
		}
		prefix, data, ok := strings.Cut(request.Messages[0].Content[1].ImageURL.URL, ",")
		submitted, err := base64.StdEncoding.DecodeString(data)
		if !ok || err != nil || !strings.HasPrefix(prefix, "data:image/") || len(submitted) > 5<<20 {
			t.Error("visual copy exceeded the inline format or byte limit")
			w.WriteHeader(400)
			return
		}
		requests <- submitted
		modelReply(w, "stop", `{"text":"","description":"红蓝合成色块"}`, map[string]int{"prompt_tokens": 100, "completion_tokens": 5})
	}))
	t.Cleanup(provider.Close)
	startImageTestWorker(t, app, storage, provider.URL)

	for _, fixture := range visualImageFixtures(t) {
		id := uuid.NewString()
		upload := confirmedImageFixtureUpload(t, app, owner, objects, fixture.data, fixture.mime)
		user.do("POST", "/collections", collectionInputForUpload(id, upload), uuid.NewString()).want(t, 201)
		var submitted []byte
		select {
		case submitted = <-requests:
		case <-time.After(6 * time.Second):
			t.Fatalf("%s did not reach the model: %v", fixture.mime, imageExtractions(t, user, id))
		}
		waitForImageStatus(t, user, id, "succeeded")
		if bytes.Contains(submitted, []byte(imageGPSMarker)) || bytes.Contains(submitted, []byte(imageCommentMarker)) {
			t.Fatalf("%s leaked metadata into the model request", fixture.mime)
		}
		pixels, format, err := image.Decode(bytes.NewReader(submitted))
		if err != nil {
			t.Fatal(err)
		}
		bounds := pixels.Bounds()
		red, blue := image.Pt(24, 24), image.Pt(72, 24)
		if fixture.mime == "image/gif" {
			if bounds.Size() != (image.Point{X: 96, Y: 48}) || format != "gif" {
				t.Fatalf("unexpected GIF visual copy: %v, %s", bounds, format)
			}
			anim, err := gif.DecodeAll(bytes.NewReader(submitted))
			if err != nil || len(anim.Image) != 2 || anim.Delay[1] != 7 {
				t.Fatalf("GIF playback lost frames or timing: %v", err)
			}
		} else {
			if bounds.Size() != (image.Point{X: 48, Y: 96}) {
				t.Fatalf("%s did not apply EXIF rotation: %v", fixture.mime, bounds)
			}
			red, blue = image.Pt(24, 24), image.Pt(24, 72)
			if fixture.mime == "image/png" {
				red, blue = blue, red // Orientation 8 turns the opposite way.
			}
		}
		r1, _, b1, _ := pixels.At(red.X, red.Y).RGBA()
		r2, _, b2, _ := pixels.At(blue.X, blue.Y).RGBA()
		if r1 <= b1 || b2 <= r2 {
			t.Fatalf("%s changed the visual orientation of the pixels", fixture.mime)
		}
		_, final := storage.Keys(owner, upload)
		objects.mu.Lock()
		preserved := bytes.Equal(objects.objects[final], fixture.data)
		objects.mu.Unlock()
		if !preserved {
			t.Fatalf("%s changed the confirmed original", fixture.mime)
		}
	}
	if len(requests) != 0 {
		t.Fatal("visual copy generated an additional model request")
	}
	usage := user.do("GET", "/me/usage", nil, "").want(t, 200)
	if usage["reserved_units"] != float64(0) || usage["settled_units"] != float64(960) {
		t.Fatalf("visual copies did not use the existing budget: %v", usage)
	}
}

func TestVisualCopyFitsRequestBudgetAfterLosslessExpansion(t *testing.T) {
	pixels := image.NewRGBA(image.Rect(0, 0, 2048, 1536))
	state := uint32(1)
	for offset := 0; offset < len(pixels.Pix); offset += 4 {
		state ^= state << 13
		state ^= state >> 17
		state ^= state << 5
		pixels.Pix[offset] = byte(state)
		pixels.Pix[offset+1] = byte(state >> 8)
		pixels.Pix[offset+2] = byte(state >> 16)
		pixels.Pix[offset+3] = 255
	}
	var original bytes.Buffer
	if err := jpeg.Encode(&original, pixels, &jpeg.Options{Quality: 87}); err != nil {
		t.Fatal(err)
	}
	copy, mime, err := visualCopy(original.Bytes(), "image/jpeg")
	if err != nil || mime != "image/jpeg" || len(copy) > 5<<20 {
		t.Fatalf("lossless expansion did not fall back to a bounded copy: %s %d %v", mime, len(copy), err)
	}
	cfg, err := jpeg.DecodeConfig(bytes.NewReader(copy))
	if err != nil || cfg.Width != 1600 || cfg.Height != 1200 {
		t.Fatalf("fallback lost the expected aspect ratio: %v %v", cfg, err)
	}
	if _, err := buildImageRequest(copy, mime); err != nil {
		t.Fatal(err)
	}
}

func TestVisualOrientationIncludesReflections(t *testing.T) {
	original := image.NewGray(image.Rect(4, 2, 7, 4))
	copy(original.Pix, "ABCDEF")
	expected := []string{"ABCDEF", "CBAFED", "FEDCBA", "DEFABC", "ADBECF", "DAEBFC", "FCEBDA", "CFBEAD"}
	for i, want := range expected {
		turned := orientedImage{Image: original, orientation: i + 1}
		var got []byte
		wantSize := image.Pt(3, 2)
		if i >= 4 {
			wantSize = image.Pt(2, 3)
		}
		if turned.Bounds().Size() != wantSize {
			t.Fatalf("orientation %d has size %v, want %v", i+1, turned.Bounds().Size(), wantSize)
		}
		for y := range wantSize.Y {
			for x := range wantSize.X {
				got = append(got, turned.At(x, y).(color.Gray).Y)
			}
		}
		if string(got) != want {
			t.Fatalf("orientation %d = %q, want %q", i+1, got, want)
		}
	}
}

type visualImageFixture struct {
	mime string
	data []byte
}

func visualImageFixtures(t *testing.T) []visualImageFixture {
	t.Helper()
	area := image.Rect(0, 0, 96, 48)
	pixels := image.NewRGBA(area)
	red := color.RGBA{R: 255, A: 255}
	blue := color.RGBA{B: 255, A: 255}
	draw.Draw(pixels, area, image.NewUniform(red), image.Point{}, draw.Src)
	draw.Draw(pixels, image.Rect(48, 0, 96, 48), image.NewUniform(blue), image.Point{}, draw.Src)
	var a, b, c bytes.Buffer
	if err := jpeg.Encode(&a, pixels, &jpeg.Options{Quality: 95}); err != nil {
		t.Fatal(err)
	}
	if err := png.Encode(&b, pixels); err != nil {
		t.Fatal(err)
	}
	first := image.NewPaletted(area, color.Palette{red, blue})
	draw.Draw(first, area, pixels, image.Point{}, draw.Src)
	second := image.NewPaletted(area, color.Palette{blue, red})
	if err := gif.EncodeAll(&c, &gif.GIF{Image: []*image.Paletted{first, second}, Delay: []int{3, 7}}); err != nil {
		t.Fatal(err)
	}
	exif6 := fixtureEXIF(6)
	segment := func(marker byte, value []byte) []byte {
		out := binary.BigEndian.AppendUint16([]byte{0xff, marker}, uint16(len(value)+2))
		return append(out, value...)
	}
	jpegSource := bytes.Join([][]byte{
		a.Bytes()[:2], segment(0xe1, append([]byte("Exif\x00\x00"), exif6...)),
		segment(0xfe, []byte(imageCommentMarker)), a.Bytes()[2:],
	}, nil)
	chunk := func(kind string, value []byte) []byte {
		raw := append([]byte(kind), value...)
		out := append(binary.BigEndian.AppendUint32(nil, uint32(len(value))), raw...)
		return binary.BigEndian.AppendUint32(out, crc32.ChecksumIEEE(raw))
	}
	pngSource := bytes.Join([][]byte{
		b.Bytes()[:33], chunk("eXIf", fixtureEXIF(8)),
		chunk("tEXt", []byte("Comment\x00"+imageCommentMarker)), b.Bytes()[33:],
	}, nil)
	comment := append([]byte{0x21, 0xfe, byte(len(imageCommentMarker))}, imageCommentMarker...)
	gifSource := bytes.Join([][]byte{c.Bytes()[:c.Len()-1], comment, {0, 0x3b}}, nil)

	// Lossless WebP encoding of the same synthetic red/blue rectangles.
	webpPixels, err := base64.StdEncoding.DecodeString("UklGRiwAAABXRUJQVlA4TB8AAAAvX8ALAA8Q87//8x8O1LRtwJQ/6Y2gV0T/J4AT8zMAAA==")
	if err != nil {
		t.Fatal(err)
	}
	webpChunk := func(kind string, value []byte) []byte {
		out := append(binary.LittleEndian.AppendUint32([]byte(kind), uint32(len(value))), value...)
		if len(value)%2 != 0 {
			out = append(out, 0)
		}
		return out
	}
	webpBody := bytes.Join([][]byte{
		[]byte("WEBP"), webpChunk("VP8X", []byte{0x0c, 0, 0, 0, 95, 0, 0, 47, 0, 0}), webpPixels[12:],
		webpChunk("EXIF", exif6), webpChunk("XMP ", []byte(imageCommentMarker)),
	}, nil)
	webpSource := append(binary.LittleEndian.AppendUint32([]byte("RIFF"), uint32(len(webpBody))), webpBody...)
	return []visualImageFixture{
		{"image/jpeg", jpegSource}, {"image/png", pngSource}, {"image/webp", webpSource}, {"image/gif", gifSource},
	}
}

func fixtureEXIF(orientation uint16) []byte {
	// A TIFF header and IFD0 with orientation and a pointer to a GPS IFD.
	order := binary.LittleEndian
	out := order.AppendUint32([]byte{'I', 'I', 42, 0}, 8)
	out = order.AppendUint16(out, 2)
	out = order.AppendUint32(order.AppendUint16(order.AppendUint16(out, 0x0112), 3), 1)
	out = order.AppendUint32(out, uint32(orientation))
	out = order.AppendUint32(order.AppendUint16(order.AppendUint16(out, 0x8825), 4), 1)
	out = order.AppendUint32(out, 38)
	out = order.AppendUint32(out, 0)
	out = order.AppendUint16(out, 1)
	out = order.AppendUint16(order.AppendUint16(out, 0x001b), 7)
	out = order.AppendUint32(out, uint32(len(imageGPSMarker)))
	out = order.AppendUint32(out, 56)
	out = order.AppendUint32(out, 0)
	return append(out, imageGPSMarker...)
}
