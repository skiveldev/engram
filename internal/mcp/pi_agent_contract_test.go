package mcp

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"

	httpserver "github.com/Gentleman-Programming/engram/v3/internal/server"
	"github.com/Gentleman-Programming/engram/v3/internal/store"
)

// TestPiAgentContractBridge is an opt-in public-protocol fixture, not a mock.
// Node owns its isolated directory and shuts it down through /stop.
func TestPiAgentContractBridge(t *testing.T) {
	dir := os.Getenv("ENGRAM_PARITY_BRIDGE")
	if dir == "" {
		t.Skip("bridge is started by the focused Node contract test")
	}
	db, err := store.New(store.FallbackConfig(filepath.Join(dir, "store")))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	core := httpserver.New(db, 0)
	defer core.Close()
	protocol := NewServerWithConfig(db, MCPConfig{DefaultProject: "parity"}, ProfileAgent)
	stopped := make(chan struct{})
	mux := http.NewServeMux()
	mux.HandleFunc("/mcp", func(w http.ResponseWriter, r *http.Request) {
		var request json.RawMessage
		if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
			http.Error(w, err.Error(), 400)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		if err := json.NewEncoder(w).Encode(protocol.HandleMessage(context.Background(), request)); err != nil {
			t.Error(err)
		}
	})
	mux.HandleFunc("/stop", func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(204); close(stopped) })
	var mu sync.Mutex
	counts := map[string]int{}
	contextQueries := []string{}
	mux.HandleFunc("/fixture/context-queries", func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		defer mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(contextQueries)
	})
	mux.HandleFunc("/fixture/requests", func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		defer mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(counts)
	})
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		counts[r.Method+" "+r.URL.Path]++
		if r.Method == "GET" && r.URL.Path == "/context" {
			contextQueries = append(contextQueries, r.URL.Query().Get("max_bytes"))
		}
		mu.Unlock()
		core.Handler().ServeHTTP(w, r)
	})
	host := httptest.NewServer(mux)
	defer host.Close()
	if err := os.WriteFile(filepath.Join(dir, "url"), []byte(host.URL), 0600); err != nil {
		t.Fatal(err)
	}
	select {
	case <-stopped:
	case <-time.After(120 * time.Second):
		t.Fatal("Node bridge shutdown timed out")
	}
}

func TestPiAgentContractProtocolMembership(t *testing.T) {
	srv := NewServerWithTools(newMCPTestStore(t), ProfileAgent)
	raw, err := json.Marshal(srv.HandleMessage(context.Background(), json.RawMessage(`{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}`)))
	if err != nil {
		t.Fatal(err)
	}
	var response struct {
		Result struct {
			Tools []struct{ Name string } `json:"tools"`
		} `json:"result"`
		Error any `json:"error"`
	}
	if err := json.Unmarshal(raw, &response); err != nil {
		t.Fatal(err)
	}
	if response.Error != nil || len(response.Result.Tools) != 19 {
		t.Fatalf("tools/list: %s", raw)
	}
	seen := map[string]bool{}
	for _, tool := range response.Result.Tools {
		if !ProfileAgent[tool.Name] || seen[tool.Name] {
			t.Fatalf("unexpected or duplicate tool %q", tool.Name)
		}
		seen[tool.Name] = true
	}
}
