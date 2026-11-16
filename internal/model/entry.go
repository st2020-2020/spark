package model

type Source string

const (
	SourceText  Source = "text"
	SourceURL   Source = "url"
	SourceImage Source = "image"
)

type Status string

const (
	StatusPending  Status = "pending"
	StatusReady    Status = "ready"
	StatusFallback Status = "fallback"
)

type Organization struct {
	Tags    []string `json:"tags"`
	Summary string   `json:"summary"`
}

type ImagePayload struct {
	Data []byte
	Type string
	Name string
}

type Entry struct {
	ID        string
	Content   string
	Source    Source
	URL       string
	Title     string
	HasImage  bool
	ImageType string
	ImageName string
	Summary   string
	Tags      []string
	Status    Status
	Provider  string
	Version   int
	CreatedAt string
	UpdatedAt string
}

func SourceLabel(s Source) string {
	switch s {
	case SourceURL:
		return "链接"
	case SourceImage:
		return "图片"
	default:
		return "文字"
	}
}
