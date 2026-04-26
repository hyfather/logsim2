package main

import (
	"log"
	"net/http"

	"github.com/nikhilm/logsim2/api/generate"
	logsat "github.com/nikhilm/logsim2/api/logs_at"
	"github.com/nikhilm/logsim2/api/run"
)

func main() {
	http.HandleFunc("/api/generate", generate.Handler)
	http.HandleFunc("/api/run", run.Handler)
	http.HandleFunc("/api/logs_at", logsat.Handler)
	log.Println("Go dev server on :8787 — /api/generate, /api/run, /api/logs_at")
	log.Fatal(http.ListenAndServe(":8787", nil))
}
