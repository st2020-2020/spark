package backend

import (
	"bytes"
	"image"
	"image/jpeg"
	"image/png"
	"testing"
)

func TestAttachmentThumbnailPrivateImage(t *testing.T) {
	app, base := testBackend(t)
	objects, _, storage := newUploadStorageFixture(t)
	app.Assets = storage
	a := imageTestAccount(t, app, base, "thumb-a")
	b := imageTestAccount(t, app, base, "thumb-b")
	path := "/attachments/" + saveImageCollection(t, app, a, objects).attachmentID + "/thumbnail"
	b.do("GET", path, nil, "").want(t, 404)
	newClient(t, app, base).do("GET", path, nil, "").want(t, 401)
	a.withHeaders("GET", path, nil, "", map[string]string{"Sec-Fetch-Site": "cross-site"}).want(t, 403)
	res, err := a.http.Get(base + "/api/v1" + path)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	if res.StatusCode != 200 || res.Header.Get("Content-Type") != "image/jpeg" || res.Header.Get("Cache-Control") != "private, no-store" || res.Header.Get("Cross-Origin-Resource-Policy") != "same-origin" {
		t.Fatalf("unexpected thumbnail response: %d, %v", res.StatusCode, res.Header.Get("Content-Type"))
	}
	img, err := jpeg.Decode(res.Body)
	if err != nil {
		t.Fatal(err)
	}
	r, g, bv, _ := img.At(1, 1).RGBA()
	if img.Bounds().Size() != image.Pt(3, 3) || min(r, g, bv) < 64000 {
		t.Fatal("transparent pixels should have a white background")
	}
}

func TestShareThumbnailBoundsOrientationAndMetadata(t *testing.T) {
	for _, fixture := range visualImageFixtures(t) {
		thumb, err := shareThumbnail(fixture.data, fixture.mime)
		if err != nil {
			t.Fatal(err)
		}
		img, err := jpeg.Decode(bytes.NewReader(thumb))
		if err != nil {
			t.Fatal(err)
		}
		size := image.Pt(48, 96)
		if fixture.mime == "image/gif" {
			size = image.Pt(96, 48)
		}
		if img.Bounds().Size() != size || bytes.Contains(thumb, []byte(imageGPSMarker)) || bytes.Contains(thumb, []byte(imageCommentMarker)) {
			t.Errorf("%s: unexpected size or metadata", fixture.mime)
		}
	}
	var src bytes.Buffer
	if err := png.Encode(&src, image.NewRGBA(image.Rect(0, 0, 1200, 800))); err != nil {
		t.Fatal(err)
	}
	thumb, err := shareThumbnail(src.Bytes(), "image/png")
	if err != nil {
		t.Fatal(err)
	}
	cfg, err := jpeg.DecodeConfig(bytes.NewReader(thumb))
	if err != nil || cfg.Width != 720 || cfg.Height != 480 {
		t.Fatalf("large thumbnail dimensions: %v, %v", cfg, err)
	}
}
