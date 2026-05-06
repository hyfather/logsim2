package search

import (
	"context"
	"fmt"
	"strings"
	"time"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"
)

// TUIOptions configures the bubbletea program. Address is shown in the
// header; RefreshInterval drives the periodic snapshot poll.
type TUIOptions struct {
	Address         string
	Registry        *Registry
	RefreshInterval time.Duration
}

// RunTUI blocks until the user exits or the program errors. The caller is
// responsible for shutting down the HTTP server / registry once RunTUI
// returns — this function does not own those.
func RunTUI(ctx context.Context, opts TUIOptions) error {
	if opts.RefreshInterval <= 0 {
		opts.RefreshInterval = 1 * time.Second
	}
	m := newModel(opts)
	p := tea.NewProgram(m, tea.WithAltScreen(), tea.WithContext(ctx))
	_, err := p.Run()
	return err
}

// --- model ------------------------------------------------------------

type viewMode int

const (
	viewList viewMode = iota
	viewSpotCheck
)

type model struct {
	opts     TUIOptions
	mode     viewMode
	width    int
	height   int
	snaps    []Snapshot
	cursor   int
	loadErr  string

	// spot-check view state
	spotCode    string
	spotEvents  []Event
	spotErr     string
	spotScroll  int
}

type tickMsg time.Time
type snapshotsMsg struct {
	snaps []Snapshot
}
type spotCheckMsg struct {
	code   string
	events []Event
	err    string
}

func newModel(opts TUIOptions) *model {
	return &model{opts: opts, mode: viewList}
}

func (m *model) Init() tea.Cmd {
	return tea.Batch(m.refreshCmd(), m.tick())
}

func (m *model) tick() tea.Cmd {
	return tea.Tick(m.opts.RefreshInterval, func(t time.Time) tea.Msg { return tickMsg(t) })
}

func (m *model) refreshCmd() tea.Cmd {
	return func() tea.Msg {
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer cancel()
		return snapshotsMsg{snaps: m.opts.Registry.Snapshots(ctx)}
	}
}

func (m *model) spotCheckCmd(code string) tea.Cmd {
	return func() tea.Msg {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		entry, err := m.opts.Registry.Get(code)
		if err != nil {
			return spotCheckMsg{code: code, err: err.Error()}
		}
		now := time.Now().UTC()
		res, err := entry.Backend.GetRaw(ctx, RawQuery{
			Range: Range{From: now.Add(-365 * 24 * time.Hour), To: now.Add(365 * 24 * time.Hour)},
			Limit: 100,
		})
		if err != nil {
			return spotCheckMsg{code: code, err: err.Error()}
		}
		return spotCheckMsg{code: code, events: res.Events}
	}
}

func (m *model) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	switch msg := msg.(type) {
	case tea.WindowSizeMsg:
		m.width = msg.Width
		m.height = msg.Height
		return m, nil

	case tickMsg:
		// In list mode, refresh on every tick. In spot-check mode, just
		// keep ticking — no auto-refresh because we don't want the buffer
		// to redraw out from under the user's eyes.
		if m.mode == viewList {
			return m, tea.Batch(m.refreshCmd(), m.tick())
		}
		return m, m.tick()

	case snapshotsMsg:
		m.snaps = msg.snaps
		if m.cursor >= len(m.snaps) {
			m.cursor = max(0, len(m.snaps)-1)
		}
		return m, nil

	case spotCheckMsg:
		m.spotCode = msg.code
		m.spotEvents = msg.events
		m.spotErr = msg.err
		m.spotScroll = 0
		return m, nil

	case tea.KeyMsg:
		switch m.mode {
		case viewList:
			return m.updateList(msg)
		case viewSpotCheck:
			return m.updateSpot(msg)
		}
	}
	return m, nil
}

func (m *model) updateList(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	switch msg.String() {
	case "q", "ctrl+c":
		return m, tea.Quit
	case "up", "k":
		if m.cursor > 0 {
			m.cursor--
		}
	case "down", "j":
		if m.cursor < len(m.snaps)-1 {
			m.cursor++
		}
	case "r":
		return m, m.refreshCmd()
	case "enter":
		if len(m.snaps) > 0 {
			m.mode = viewSpotCheck
			code := m.snaps[m.cursor].Code
			m.spotCode = code
			m.spotEvents = nil
			m.spotErr = ""
			return m, m.spotCheckCmd(code)
		}
	}
	return m, nil
}

func (m *model) updateSpot(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	switch msg.String() {
	case "q", "ctrl+c":
		return m, tea.Quit
	case "esc", "backspace", "h":
		m.mode = viewList
		return m, nil
	case "r":
		return m, m.spotCheckCmd(m.spotCode)
	case "up", "k":
		if m.spotScroll > 0 {
			m.spotScroll--
		}
	case "down", "j":
		if m.spotScroll < len(m.spotEvents)-1 {
			m.spotScroll++
		}
	case "pgup":
		m.spotScroll = max(0, m.spotScroll-10)
	case "pgdown":
		m.spotScroll = min(len(m.spotEvents)-1, m.spotScroll+10)
	case "g":
		m.spotScroll = 0
	case "G":
		m.spotScroll = max(0, len(m.spotEvents)-1)
	}
	return m, nil
}

// --- view -------------------------------------------------------------

var (
	headerStyle = lipgloss.NewStyle().Bold(true).Foreground(lipgloss.Color("#7ee787"))
	subtle      = lipgloss.NewStyle().Foreground(lipgloss.Color("#7d8590"))
	colHeader   = lipgloss.NewStyle().Bold(true).Foreground(lipgloss.Color("#7d8590"))
	rowSelected = lipgloss.NewStyle().Background(lipgloss.Color("#264F78"))
	footer      = lipgloss.NewStyle().Foreground(lipgloss.Color("#7d8590")).Italic(true)
	errStyle    = lipgloss.NewStyle().Foreground(lipgloss.Color("#f85149"))
)

func (m *model) View() string {
	switch m.mode {
	case viewSpotCheck:
		return m.viewSpotCheck()
	default:
		return m.viewList()
	}
}

func (m *model) viewList() string {
	var b strings.Builder

	totalEvents := int64(0)
	for _, s := range m.snaps {
		totalEvents += s.EventCount
	}
	header := fmt.Sprintf("logsim search · %s · %d %s · %d events",
		m.opts.Address, len(m.snaps), pluralize("db", len(m.snaps)), totalEvents)
	b.WriteString(headerStyle.Render(header))
	b.WriteString("\n")
	b.WriteString(subtle.Render("HEC ingest: POST " + m.opts.Address + "/dbs/<code>/services/collector/event"))
	b.WriteString("\n\n")

	if len(m.snaps) == 0 {
		b.WriteString(subtle.Render("no databases yet — try `logsim run <scenario> --to local` in another shell"))
		b.WriteString("\n")
	} else {
		b.WriteString(colHeader.Render(fmt.Sprintf("%-8s %10s   %-26s %-26s %s",
			"CODE", "EVENTS", "OLDEST", "NEWEST", "AGE")))
		b.WriteString("\n")
		for i, s := range m.snaps {
			row := fmt.Sprintf("%-8s %10d   %-26s %-26s %s",
				s.Code,
				s.EventCount,
				renderTime(s.OldestEvent),
				renderTime(s.NewestEvent),
				humanAge(time.Since(s.CreatedAt)))
			if i == m.cursor {
				b.WriteString(rowSelected.Render(row))
			} else {
				b.WriteString(row)
			}
			b.WriteString("\n")
		}
	}
	b.WriteString("\n")
	b.WriteString(footer.Render("↑/↓ select · enter spot-check · r refresh · q/ctrl-c quit"))
	if m.loadErr != "" {
		b.WriteString("\n")
		b.WriteString(errStyle.Render("error: " + m.loadErr))
	}
	return b.String()
}

func (m *model) viewSpotCheck() string {
	var b strings.Builder
	b.WriteString(headerStyle.Render(fmt.Sprintf("logsim search · db %s · spot-check (first 100)", m.spotCode)))
	b.WriteString("\n\n")

	if m.spotErr != "" {
		b.WriteString(errStyle.Render("error: " + m.spotErr))
		b.WriteString("\n\n")
	}
	if len(m.spotEvents) == 0 && m.spotErr == "" {
		b.WriteString(subtle.Render("no events"))
		b.WriteString("\n")
	}

	// How many rows fit on screen? Header(2) + footer(2) ≈ 5.
	rows := m.height - 6
	if rows < 5 {
		rows = 5
	}
	end := min(len(m.spotEvents), m.spotScroll+rows)
	for i := m.spotScroll; i < end; i++ {
		ev := m.spotEvents[i]
		ts := ev.Time.UTC().Format("2006-01-02T15:04:05Z")
		line := fmt.Sprintf("%s %s %s",
			subtle.Render(ts),
			subtle.Render(safe(ev.Sourcetype, "-")),
			truncate(ev.Raw, m.width-len(ts)-len(safe(ev.Sourcetype, "-"))-2))
		b.WriteString(line)
		b.WriteString("\n")
	}
	b.WriteString("\n")
	b.WriteString(footer.Render(fmt.Sprintf(
		"showing %d–%d of %d · ↑/↓ scroll · g/G top/bottom · r refresh · esc back · q quit",
		m.spotScroll+1, end, len(m.spotEvents))))
	return b.String()
}

// --- helpers ----------------------------------------------------------

func renderTime(t time.Time) string {
	if t.IsZero() {
		return "-"
	}
	return t.UTC().Format("2006-01-02 15:04:05Z")
}

func humanAge(d time.Duration) string {
	if d < time.Second {
		return "just now"
	}
	if d < time.Minute {
		return fmt.Sprintf("%ds", int(d.Seconds()))
	}
	if d < time.Hour {
		return fmt.Sprintf("%dm", int(d.Minutes()))
	}
	return fmt.Sprintf("%dh", int(d.Hours()))
}

func pluralize(s string, n int) string {
	if n == 1 {
		return s
	}
	return s + "s"
}

func safe(s, fallback string) string {
	if s == "" {
		return fallback
	}
	return s
}

func truncate(s string, w int) string {
	if w <= 0 {
		return ""
	}
	if len(s) <= w {
		return s
	}
	if w <= 1 {
		return string(s[0])
	}
	return s[:w-1] + "…"
}

