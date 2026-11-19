package backend

import (
	"bytes"
	"errors"
	"image"
	"image/gif"
	"image/jpeg"
	"image/png"
	"io"

	"golang.org/x/image/draw"
)

var errVisualCopyTooLarge = errors.New("visual copy exceeds image byte limit")

// visualCopy only encodes decoded pixels and GIF playback data. Original
// container segments and chunks, including EXIF, GPS and comments, never
// enter the request.
func visualCopy(data []byte, mime string) ([]byte, string, error) {
	cfg, format, err := image.DecodeConfig(bytes.NewReader(data))
	if err != nil || "image/"+format != mime || !validImageDimensions(cfg) {
		return nil, "", errors.New("invalid confirmed image for analysis")
	}
	var pixels image.Image
	if format == "gif" {
		if !boundedGIF(data) {
			return nil, "", errors.New("invalid confirmed GIF for analysis")
		}
		anim, err := gif.DecodeAll(bytes.NewReader(data))
		if err != nil {
			return nil, "", err
		}
		body, err := encodeVisual(func(w io.Writer) error { return gif.EncodeAll(w, anim) })
		if !errors.Is(err, errVisualCopyTooLarge) {
			return body, "image/gif", err
		}
		// Oversized re-encoding falls back to a still on the logical canvas.
		canvas := image.NewRGBA(image.Rect(0, 0, cfg.Width, cfg.Height))
		first := anim.Image[0]
		draw.Draw(canvas, first.Bounds(), first, first.Bounds().Min, draw.Over)
		pixels = canvas
	} else {
		pixels, _, err = image.Decode(bytes.NewReader(data))
		if err != nil {
			return nil, "", err
		}
		if orientation := exifOrientation(data, mime); orientation != 1 {
			pixels = orientedImage{Image: pixels, orientation: orientation}
		}
	}
	body, err := encodeVisual(func(w io.Writer) error { return png.Encode(w, pixels) })
	if !errors.Is(err, errVisualCopyTooLarge) {
		return body, "image/png", err
	}
	// A compact WebP or JPEG can expand substantially as PNG. Preserve the
	// aspect ratio, flatten transparency over white, and bound the fallback.
	const maxJPEGSide = 1600
	bounds := pixels.Bounds()
	width, height := bounds.Dx(), bounds.Dy()
	if longest := max(width, height); longest > maxJPEGSide {
		width = max(1, width*maxJPEGSide/longest)
		height = max(1, height*maxJPEGSide/longest)
	}
	flat := image.NewRGBA(image.Rect(0, 0, width, height))
	draw.Draw(flat, flat.Bounds(), image.White, image.Point{}, draw.Src)
	draw.ApproxBiLinear.Scale(flat, flat.Bounds(), pixels, bounds, draw.Over, nil)
	body, err = encodeVisual(func(w io.Writer) error {
		return jpeg.Encode(w, flat, &jpeg.Options{Quality: 88})
	})
	return body, "image/jpeg", err
}

func encodeVisual(encode func(io.Writer) error) ([]byte, error) {
	var dst visualBuffer
	if err := encode(&dst); err != nil {
		return nil, err
	}
	return dst.data.Bytes(), nil
}

type visualBuffer struct{ data bytes.Buffer }

func (b *visualBuffer) Write(data []byte) (int, error) {
	if len(data) > maxImageBytes-b.data.Len() {
		return 0, errVisualCopyTooLarge
	}
	return b.data.Write(data)
}
