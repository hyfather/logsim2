package search

import (
	"regexp"
	"testing"
)

var codeShape = regexp.MustCompile(`^[a-z0-9]{6}$`)

func TestNewCodeShape(t *testing.T) {
	for i := 0; i < 1000; i++ {
		c := NewCode()
		if !codeShape.MatchString(c) {
			t.Fatalf("NewCode = %q, want 6 lowercase alphanumerics", c)
		}
	}
}

func TestNewCodeUnique(t *testing.T) {
	// 1k random 36^6 codes virtually never collide; this catches a buggy
	// rng seeding regression (seen in earlier draft using time-seeded
	// math/rand which produced identical codes within a single run).
	seen := make(map[string]bool)
	for i := 0; i < 1000; i++ {
		c := NewCode()
		if seen[c] {
			t.Fatalf("collision on %q after %d codes", c, i)
		}
		seen[c] = true
	}
}

func TestNormalizeCode(t *testing.T) {
	cases := []struct {
		in      string
		want    string
		wantErr bool
	}{
		{"abc123", "abc123", false},
		{"ABC123", "abc123", false},
		{"  abc123  ", "abc123", false},
		{"abc12", "", true},   // too short
		{"abc1234", "", true}, // too long
		{"abc12!", "", true},  // bad char
	}
	for _, tc := range cases {
		got, err := NormalizeCode(tc.in)
		if tc.wantErr {
			if err == nil {
				t.Errorf("NormalizeCode(%q) = %q, want error", tc.in, got)
			}
			continue
		}
		if err != nil {
			t.Errorf("NormalizeCode(%q): unexpected error %v", tc.in, err)
			continue
		}
		if got != tc.want {
			t.Errorf("NormalizeCode(%q) = %q, want %q", tc.in, got, tc.want)
		}
	}
}

func TestCodeFromSlug(t *testing.T) {
	cases := []struct {
		slug, want string
	}{
		{"web-service", "webser"},
		{"db-slowdown-cascade", "dbslow"},
		{"a", "a00000"},
		{"!!!", "000000"},
		{"123-456", "123456"},
	}
	for _, tc := range cases {
		got := CodeFromSlug(tc.slug)
		if got != tc.want {
			t.Errorf("CodeFromSlug(%q) = %q, want %q", tc.slug, got, tc.want)
		}
		if !codeShape.MatchString(got) {
			t.Errorf("CodeFromSlug(%q) = %q is not a valid code", tc.slug, got)
		}
	}
}
