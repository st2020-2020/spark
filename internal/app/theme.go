package app

import "github.com/egoist/mygo/ui"

type palette struct {
	bg            ui.Color
	sidebarBg     ui.Color
	cardBg        ui.Color
	subtleBg      ui.Color
	text          ui.Color
	muted         ui.Color
	border        ui.Color
	borderStrong  ui.Color
	primary       ui.Color
	primaryHover  ui.Color
	accentSoft    ui.Color
	danger        ui.Color
	dangerSoft    ui.Color
	heatmapLevels [5]ui.Color
}

func currentPalette(c *ui.Context) palette {
	if c.Theme().Dark {
		return palette{
			bg:           ui.Hex("#161917"),
			sidebarBg:    ui.Hex("#1b1f1c"),
			cardBg:       ui.Hex("#202521"),
			subtleBg:     ui.Hex("#262c28"),
			text:         ui.Hex("#e7ece8"),
			muted:        ui.Hex("#99a39c"),
			border:       ui.Hex("#2c332e"),
			borderStrong: ui.Hex("#3d4740"),
			primary:      ui.Hex("#35966d"),
			primaryHover: ui.Hex("#2b7d5b"),
			accentSoft:   ui.Hex("#1e362a"),
			danger:       ui.Hex("#e05d6d"),
			dangerSoft:   ui.Hex("#361f23"),
			heatmapLevels: [5]ui.Color{
				ui.Hex("#272e29"),
				ui.Hex("#214735"),
				ui.Hex("#29664a"),
				ui.Hex("#328962"),
				ui.Hex("#3ead7d"),
			},
		}
	}
	return palette{
		bg:           ui.Hex("#f6f7f6"),
		sidebarBg:    ui.Hex("#f2f4f2"),
		cardBg:       ui.Hex("#ffffff"),
		subtleBg:     ui.Hex("#f4f6f4"),
		text:         ui.Hex("#343b36"),
		muted:        ui.Hex("#747d77"),
		border:       ui.Hex("#e5e9e6"),
		borderStrong: ui.Hex("#c8d2cb"),
		primary:      ui.Hex("#287b59"),
		primaryHover: ui.Hex("#206347"),
		accentSoft:   ui.Hex("#e6f2eb"),
		danger:       ui.Hex("#b83545"),
		dangerSoft:   ui.Hex("#fff0f1"),
		heatmapLevels: [5]ui.Color{
			ui.Hex("#e7ebe8"),
			ui.Hex("#bfe0cd"),
			ui.Hex("#82c4a3"),
			ui.Hex("#479d76"),
			ui.Hex("#287b59"),
		},
	}
}

func applySparkTheme(c *ui.Context) palette {
	p := currentPalette(c)
	base := *c.Theme().WithAccent(p.primary)
	base.Background = p.bg
	base.Surface = p.cardBg
	base.SurfaceHover = p.subtleBg
	base.Border = p.border
	base.Text = p.text
	base.TextMuted = p.muted
	base.Danger = p.danger
	base.Radius = 6
	base.Spacing = 4
	base.FontSize = 14
	c.SetTheme(&base)
	return p
}
