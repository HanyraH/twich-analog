package main

import (
	"encoding/json"
	"log"
	"net/http"
	"os"
	"strconv"
	"strings"

	"github.com/gorilla/websocket"
)

var upgrader = websocket.Upgrader{
	ReadBufferSize:  1024,
	WriteBufferSize: 1024,
	CheckOrigin: func(r *http.Request) bool {
		return true
	},
}

func normalizeRoom(raw string) string {
	room := strings.TrimSpace(raw)
	room = strings.Trim(room, "/")
	if room == "" {
		return "live/stream"
	}
	if len(room) > 120 {
		room = room[:120]
	}
	return room
}

func newHTTPHandler(hub *Hub, jwtSecret string) http.Handler {
	mux := http.NewServeMux()

	mux.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"status": "ok",
			"rooms":  hub.RoomStats(),
		})
	})

	mux.HandleFunc("/ws", func(w http.ResponseWriter, r *http.Request) {
		room := normalizeRoom(r.URL.Query().Get("room"))

		tokenStr := strings.TrimSpace(r.URL.Query().Get("token"))
		if tokenStr == "" {
			authHeader := r.Header.Get("Authorization")
			if strings.HasPrefix(strings.ToLower(authHeader), "bearer ") {
				tokenStr = strings.TrimSpace(authHeader[7:])
			}
		}

		var user *UserIdentity
		if tokenStr != "" {
			verified, err := VerifyToken(tokenStr, jwtSecret)
			if err != nil {
				http.Error(w, "unauthorized: "+err.Error(), http.StatusUnauthorized)
				return
			}
			user = verified
		}

		conn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			return
		}

		client := NewClient(hub, conn, room, user)
		history, online := hub.Register(client)

		initPayload, err := json.Marshal(ServerEvent{
			Type:     "history",
			Room:     room,
			Messages: history,
			Online:   online,
		})
		if err == nil {
			client.trySend(initPayload)
		}

		go client.writePump()
		client.readPump()
	})

	return mux
}

func main() {
	LoadEnvFiles(".env", "../.env")

	jwtSecret := os.Getenv("JWT_SECRET_KEY")
	if jwtSecret == "" {
		log.Fatal("JWT_SECRET_KEY is required (set in environment or ../.env)")
	}

	port := os.Getenv("CHAT_PORT")
	if port == "" {
		port = "8081"
	}

	historyLimit := 50
	if raw := os.Getenv("CHAT_HISTORY_LIMIT"); raw != "" {
		if parsed, err := strconv.Atoi(raw); err == nil && parsed > 0 {
			historyLimit = parsed
		}
	}

	hub := NewHub(historyLimit)
	addr := ":" + port
	log.Printf("Go chat WebSocket server listening on http://127.0.0.1%s (ws://127.0.0.1%s/ws)", addr, addr)
	if err := http.ListenAndServe(addr, newHTTPHandler(hub, jwtSecret)); err != nil {
		log.Fatal(err)
	}
}
