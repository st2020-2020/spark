package backend

import (
	"bytes"
	"crypto/sha256"
	"encoding/binary"
	"image"
	"image/gif"
	_ "image/jpeg"
	_ "image/png"
	"io"

	_ "golang.org/x/image/webp"
)

const (
	maxImageBytes  = 5 << 20
	maxImageSide   = 8192
	maxImagePixels = 16 << 20
)

func verifyImage(body io.Reader, size int64, mime string) ([]byte, string, error) {
	data, err := io.ReadAll(io.LimitReader(body, maxImageBytes+1))
	if err != nil {
		return nil, "", err
	}
	if len(data) > maxImageBytes || int64(len(data)) != size {
		return nil, "upload_size_mismatch", nil
	}
	cfg, format, err := image.DecodeConfig(bytes.NewReader(data))
	if err != nil || "image/"+format != mime {
		return nil, "invalid_image", nil
	}
	if !validImageDimensions(cfg) {
		return nil, "image_too_large", nil
	}
	if format == "gif" {
		if !boundedGIF(data) {
			return nil, "invalid_image", nil
		}
		_, err = gif.DecodeAll(bytes.NewReader(data))
	} else {
		_, _, err = image.Decode(bytes.NewReader(data))
	}
	if err != nil {
		return nil, "invalid_image", nil
	}
	sum := sha256.Sum256(data)
	return sum[:], "", nil
}

func validImageDimensions(cfg image.Config) bool {
	return cfg.Width > 0 && cfg.Height > 0 && cfg.Width <= maxImageSide && cfg.Height <= maxImageSide &&
		int64(cfg.Width)*int64(cfg.Height) <= maxImagePixels
}

// Walk GIF blocks before decoding. DecodeAll retains every frame, so a small
// compressed file must fit the total frame budget as well as the canvas limit.
func boundedGIF(data []byte) bool {
	if len(data) < 13 {
		return false
	}
	offset := 13 + gifColorTableBytes(data[10])
	var pixels int64
	frames := 0
	for offset < len(data) {
		marker := data[offset]
		offset++
		switch marker {
		case 0x3b: // Trailer
			return offset == len(data) && frames > 0
		case 0x21: // Extension label followed by data sub-blocks
			offset++
		case 0x2c: // Image descriptor and LZW code size
			if len(data)-offset < 9 {
				return false
			}
			w := binary.LittleEndian.Uint16(data[offset+4:])
			h := binary.LittleEndian.Uint16(data[offset+6:])
			pixels += int64(w) * int64(h)
			frames++
			if frames > 512 || w == 0 || h == 0 || pixels > 2*maxImagePixels {
				return false
			}
			offset += 9 + gifColorTableBytes(data[offset+8]) + 1
		default:
			return false
		}
		for {
			if offset >= len(data) {
				return false
			}
			n := int(data[offset])
			offset++
			if n == 0 {
				break
			}
			offset += n
		}
	}
	return false
}

func gifColorTableBytes(flags byte) int {
	if flags&0x80 == 0 {
		return 0
	}
	return 3 * (2 << (flags & 7))
}
