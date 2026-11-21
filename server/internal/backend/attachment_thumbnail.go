package backend

import (
	"bytes"
	"image"
	"image/jpeg"
	"net/http"

	"github.com/gin-gonic/gin"
	"golang.org/x/image/draw"
	"spark/server/internal/store"
)

// A confirmed attachment can expand to 16 megapixels during decoding.
var thumbnailSlot = make(chan struct{}, 1)

func (s *Server) attachmentThumbnail(c *gin.Context) (any, error) {
	if s.crossOriginRead(c) {
		return nil, problem(403, "forbidden", "缩略图仅支持同源请求。")
	}
	if s.Assets == nil {
		return nil, uploadsUnavailable
	}
	ctx := c.Request.Context()
	q := store.New(s.Pool)
	params := store.GetAttachmentForDownloadParams{UserID: idPG(current(c).User.ID), ID: idPG(c.Param("id"))}
	row, err := q.GetAttachmentForDownload(ctx, params)
	if err != nil {
		return nil, err
	}
	if err := s.chargeAssetLimit(c, s.Pool, "get", 1, maxGETsPerSigningWindow, assetSigningWindow); err != nil {
		return nil, err
	}
	select {
	case thumbnailSlot <- struct{}{}:
		defer func() { <-thumbnailSlot }()
	case <-ctx.Done():
		return nil, ctx.Err()
	}
	data, err := readImageObject(ctx, s.Assets, imageJob{
		Key: row.ObjectKey, Version: row.ProviderVersion.String, Size: row.SizeBytes, SHA: row.Sha256,
	})
	if err != nil {
		return nil, problem(503, "thumbnail_unavailable", "暂时无法读取缩略图，请重试。")
	}
	thumb, err := shareThumbnail(data, row.MimeType)
	if err != nil {
		return nil, err
	}
	// Rendering may outlive an edit removing the attachment or a purge.
	if _, err := q.GetAttachmentForDownload(ctx, params); err != nil {
		return nil, err
	}
	c.Header("Cache-Control", "private, no-store")
	c.Header("Cross-Origin-Resource-Policy", "same-origin")
	c.Data(http.StatusOK, "image/jpeg", thumb)
	return nil, nil
}

func shareThumbnail(data []byte, mime string) ([]byte, error) {
	reader := bytes.NewReader(data)
	cfg, format, err := image.DecodeConfig(reader)
	if err != nil || "image/"+format != mime || !validImageDimensions(cfg) {
		return nil, problem(422, "invalid_image", "无法生成这张图片的缩略图。")
	}
	// Decode only the first frame of animated images.
	pixels, _, err := image.Decode(bytes.NewReader(data))
	if err != nil {
		return nil, err
	}
	if format == "gif" && pixels.Bounds() != image.Rect(0, 0, cfg.Width, cfg.Height) {
		// A GIF frame may occupy only part of its logical canvas.
		canvas := image.NewRGBA(image.Rect(0, 0, cfg.Width, cfg.Height))
		draw.Draw(canvas, pixels.Bounds(), pixels, pixels.Bounds().Min, draw.Src)
		pixels = canvas
	}
	if orientation := exifOrientation(data, mime); orientation != 1 {
		pixels = orientedImage{Image: pixels, orientation: orientation}
	}
	bounds := pixels.Bounds()
	w, h := bounds.Dx(), bounds.Dy()
	const maxSide = 720
	if longest := max(w, h); longest > maxSide {
		w, h = max(1, w*maxSide/longest), max(1, h*maxSide/longest)
	}
	dst := image.NewRGBA(image.Rect(0, 0, w, h))
	draw.Draw(dst, dst.Bounds(), image.White, image.Point{}, draw.Src)
	draw.ApproxBiLinear.Scale(dst, dst.Bounds(), pixels, bounds, draw.Over, nil)
	var out bytes.Buffer
	if err := jpeg.Encode(&out, dst, &jpeg.Options{Quality: 85}); err != nil {
		return nil, err
	}
	return out.Bytes(), nil
}
