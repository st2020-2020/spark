package backend

import (
	"bytes"
	"encoding/binary"
	"image"
	"image/color"
)

func exifOrientation(data []byte, mime string) int {
	var exif []byte
	switch mime {
	case "image/jpeg":
		exif = jpegEXIF(data)
	case "image/png":
		exif = pngEXIF(data)
	case "image/webp":
		exif = webpEXIF(data)
	}
	exif = bytes.TrimPrefix(exif, []byte("Exif\x00\x00"))
	if len(exif) < 8 {
		return 1
	}
	var order binary.ByteOrder
	switch string(exif[:2]) {
	case "II":
		order = binary.LittleEndian
	case "MM":
		order = binary.BigEndian
	default:
		return 1
	}
	offset := int(order.Uint32(exif[4:8]))
	if order.Uint16(exif[2:4]) != 42 || offset < 8 || offset > len(exif)-2 {
		return 1
	}
	entries := int(order.Uint16(exif[offset : offset+2]))
	ifd := exif[offset+2:]
	if entries > len(ifd)/12 {
		return 1
	}
	for i := range entries {
		entry := ifd[i*12 : i*12+12]
		if order.Uint16(entry[:2]) == 0x0112 && order.Uint16(entry[2:4]) == 3 && order.Uint32(entry[4:8]) == 1 {
			if orientation := int(order.Uint16(entry[8:10])); orientation >= 1 && orientation <= 8 {
				return orientation
			}
		}
	}
	return 1
}

func jpegEXIF(data []byte) []byte {
	if len(data) < 2 || data[0] != 0xff || data[1] != 0xd8 {
		return nil
	}
	for data = data[2:]; len(data) >= 2 && data[0] == 0xff; {
		marker := data[1]
		if marker == 0xff {
			data = data[1:]
			continue
		}
		data = data[2:]
		if marker == 0xda || marker == 0xd9 || len(data) < 2 {
			return nil
		}
		size := int(binary.BigEndian.Uint16(data[:2]))
		if size < 2 || size > len(data) {
			return nil
		}
		if marker == 0xe1 && bytes.HasPrefix(data[2:size], []byte("Exif\x00\x00")) {
			return data[2:size]
		}
		data = data[size:]
	}
	return nil
}

func pngEXIF(data []byte) []byte {
	const signature = "\x89PNG\r\n\x1a\n"
	if !bytes.HasPrefix(data, []byte(signature)) {
		return nil
	}
	for data = data[len(signature):]; len(data) >= 12; {
		n := binary.BigEndian.Uint32(data[:4])
		if n > uint32(len(data)-12) {
			return nil
		}
		size := int(n)
		switch string(data[4:8]) {
		case "eXIf":
			return data[8 : 8+size]
		case "IEND":
			return nil
		}
		data = data[12+size:]
	}
	return nil
}

func webpEXIF(data []byte) []byte {
	if len(data) < 12 || string(data[:4]) != "RIFF" || string(data[8:12]) != "WEBP" {
		return nil
	}
	n := binary.LittleEndian.Uint32(data[4:8])
	if n < 4 || n > uint32(len(data)-8) {
		return nil
	}
	for data = data[12 : 8+int(n)]; len(data) >= 8; {
		n := binary.LittleEndian.Uint32(data[4:8])
		if uint64(n)+uint64(n%2) > uint64(len(data)-8) {
			return nil
		}
		size := int(n)
		padded := size + size%2
		if string(data[:4]) == "EXIF" {
			return data[8 : 8+size]
		}
		data = data[8+padded:]
	}
	return nil
}

// EXIF orientations 2 through 8 map visual coordinates back to source
// pixels. The wrapper lets the encoder read these pixels without a second
// full-size decoded image.
type orientedImage struct {
	image.Image
	orientation int
}

func (im orientedImage) Bounds() image.Rectangle {
	bounds := im.Image.Bounds()
	if im.orientation >= 5 {
		return image.Rect(0, 0, bounds.Dy(), bounds.Dx())
	}
	return image.Rect(0, 0, bounds.Dx(), bounds.Dy())
}

func (im orientedImage) At(x, y int) color.Color {
	bounds := im.Image.Bounds()
	width, height := bounds.Dx(), bounds.Dy()
	switch im.orientation {
	case 2:
		x = width - 1 - x
	case 3:
		x, y = width-1-x, height-1-y
	case 4:
		y = height - 1 - y
	case 5:
		x, y = y, x
	case 6:
		x, y = y, height-1-x
	case 7:
		x, y = width-1-y, height-1-x
	case 8:
		x, y = width-1-y, x
	}
	return im.Image.At(bounds.Min.X+x, bounds.Min.Y+y)
}
