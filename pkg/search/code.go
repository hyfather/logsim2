package search

import (
	"crypto/rand"
	"errors"
	"regexp"
	"strings"
)

// CodeLen is the fixed length of a db code. Tunable in one place if we ever
// outgrow 36^6 ≈ 2.2B values.
const CodeLen = 6

const codeAlphabet = "abcdefghijklmnopqrstuvwxyz0123456789"

var codeRe = regexp.MustCompile(`^[a-z0-9]{6}$`)

// ErrInvalidCode is returned when a caller-supplied code doesn't match the
// 6-char [a-z0-9] shape.
var ErrInvalidCode = errors.New("code must be 6 lowercase alphanumeric characters")

// NewCode returns a fresh random 6-char code. Caller is responsible for
// collision detection against the registry.
func NewCode() string {
	var b [CodeLen]byte
	// crypto/rand is overkill for a 36^6 namespace but it's the simplest way
	// to avoid seeding a math/rand and accidentally getting deterministic
	// codes across daemon restarts.
	if _, err := rand.Read(b[:]); err != nil {
		panic("crypto/rand failed: " + err.Error())
	}
	out := make([]byte, CodeLen)
	for i, c := range b {
		out[i] = codeAlphabet[int(c)%len(codeAlphabet)]
	}
	return string(out)
}

// NormalizeCode lowercases and validates a caller-supplied code. Returns
// ErrInvalidCode when the input doesn't match the canonical shape.
func NormalizeCode(s string) (string, error) {
	s = strings.ToLower(strings.TrimSpace(s))
	if !codeRe.MatchString(s) {
		return "", ErrInvalidCode
	}
	return s, nil
}

// CodeFromSlug derives a deterministic 6-char code from a free-form name
// (typically a scenario slug). Used by `--to local` so repeated runs of
// the same scenario reuse the same db. Non-alphanumerics are dropped;
// the result is right-padded with '0' if shorter than 6 chars.
func CodeFromSlug(slug string) string {
	slug = strings.ToLower(slug)
	var b strings.Builder
	for _, r := range slug {
		if (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9') {
			b.WriteRune(r)
		}
		if b.Len() == CodeLen {
			break
		}
	}
	for b.Len() < CodeLen {
		b.WriteByte('0')
	}
	return b.String()
}
