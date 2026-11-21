package backend

import (
	"archive/zip"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"iter"
	"time"

	"github.com/jackc/pgx/v5"
)

// Merge the collection, project-decision, and tag-decision streams.
// Decisions are paged independently to keep the export's memory bounded.
func writeExport(ctx context.Context, tx pgx.Tx, uid string, z *zip.Writer, format string, at time.Time) (int, error) {
	s := exportSnapshot{ctx, tx, uid}
	var data io.Writer
	var md markdownArchive
	var err error
	if format == "json" {
		data, err = z.Create("spark-export.json")
		if err == nil {
			_, err = fmt.Fprintf(data, `{"version":1,"exported_at":%q,"projects":[`, at.UTC().Format(time.RFC3339Nano))
		}
	} else {
		md = newMarkdownArchive(z)
		err = md.readme(at)
	}
	if err != nil {
		return 0, err
	}
	first := true
	for p, err := range s.projects() {
		if err != nil {
			return 0, err
		}
		if data != nil {
			err = writeExportJSON(data, p, first)
		} else {
			err = md.project(p)
		}
		if err != nil {
			return 0, err
		}
		first = false
	}
	if data != nil {
		if _, err = io.WriteString(data, `],"tags":[`); err != nil {
			return 0, err
		}
		first = true
		for tag, err := range s.tags() {
			if err != nil {
				return 0, err
			}
			if err = writeExportJSON(data, tag, first); err != nil {
				return 0, err
			}
			first = false
		}
		if _, err = io.WriteString(data, `],"collections":[`); err != nil {
			return 0, err
		}
	}
	next, stop := iter.Pull2(s.decisions())
	defer stop()
	d, linkErr, ok := next()
	nextTag, stopTags := iter.Pull2(s.tagDecisions())
	defer stopTags()
	tag, tagErr, hasTag := nextTag()
	count := 0
	for c, err := range s.collections() {
		if err != nil {
			return count, err
		}
		if linkErr != nil {
			return count, linkErr
		}
		var entry io.Writer
		if data != nil {
			err = startJSONCollection(data, c, count == 0)
		} else {
			folder := "unclassified"
			if ok && d.collectionID == c.ID && !d.unassigned {
				folder = md.folders[d.ProjectId]
			}
			entry, err = md.collection(folder, c)
		}
		if err != nil {
			return count, err
		}
		firstLink := true
		for ok && d.collectionID == c.ID {
			if data != nil {
				err = writeExportJSON(data, d.ProjectAssociation, firstLink)
			} else {
				_, err = fmt.Fprintf(entry, "- %s（%s）\n", mdLine(d.Name), d.Decision)
			}
			if err != nil {
				return count, err
			}
			firstLink = false
			d, linkErr, ok = next()
			if linkErr != nil {
				return count, linkErr
			}
		}
		if tagErr != nil {
			return count, tagErr
		}
		if data != nil {
			_, err = io.WriteString(data, `],"tags":[`)
		} else if hasTag && tag.collectionID == c.ID {
			_, err = io.WriteString(entry, "\n标签决定：\n")
		}
		if err != nil {
			return count, err
		}
		firstTag := true
		for hasTag && tag.collectionID == c.ID {
			if data != nil {
				err = writeExportJSON(data, tag.TagAssociation, firstTag)
			} else {
				_, err = fmt.Fprintf(entry, "- %s（%s）\n", mdLine(tag.Path), tag.Decision)
			}
			if err != nil {
				return count, err
			}
			firstTag = false
			tag, tagErr, hasTag = nextTag()
			if tagErr != nil {
				return count, tagErr
			}
		}
		if data != nil {
			_, err = io.WriteString(data, "]}")
		} else {
			body, convErr := documentMarkdown(c.Document)
			if convErr != nil {
				return count, convErr
			}
			_, err = fmt.Fprintf(entry, "\n## 正文\n\n%s\n", body)
			for _, note := range c.ImageNotes {
				if err != nil {
					break
				}
				_, err = fmt.Fprintf(entry, "\n%s\n", markdownEscape.Replace(note.Text))
			}
		}
		if err != nil {
			return count, err
		}
		count++
	}
	if linkErr != nil {
		return count, linkErr
	}
	if tagErr != nil {
		return count, tagErr
	}
	if data != nil {
		_, err = io.WriteString(data, "]}")
	}
	return count, err
}

// Leave the projects array open so its decisions can be written a page at a time.
func startJSONCollection(w io.Writer, c exportCollection, first bool) error {
	record, err := json.Marshal(c)
	if err != nil {
		return err
	}
	if !first {
		if _, err = io.WriteString(w, ","); err != nil {
			return err
		}
	}
	if _, err = w.Write(record[:len(record)-1]); err != nil {
		return err
	}
	_, err = io.WriteString(w, `,"projects":[`)
	return err
}

func writeExportJSON(w io.Writer, v any, first bool) error {
	if !first {
		if _, err := io.WriteString(w, ","); err != nil {
			return err
		}
	}
	return json.NewEncoder(w).Encode(v)
}
