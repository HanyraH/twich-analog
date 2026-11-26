package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"github.com/gorilla/websocket"
)

func makeTestToken(t *testing.T, secret, sub, email string, exp time.Time) string {
	t.Helper()
	claims := tokenClaims{
		Email: email,
		RegisteredClaims: jwt.RegisteredClaims{
			Subject:   sub,
			ExpiresAt: jwt.NewNumericDate(exp),
		},
	}
	tok := jwt.NewWithClaims(jwt.SigningMethodHS256, claims)
	signed, err := tok.SignedString([]byte(secret))
	if err != nil {
		t.Fatalf("sign token: %v", err)
	}
	return signed
}

func TestVerifyToken(t *testing.T) {
	const secret = "test-secret-key"

	valid := makeTestToken(t, secret, "42", "streamer@example.com", time.Now().Add(10*time.Minute))
	id, err := VerifyToken(valid, secret)
	if err != nil {
		t.Fatalf("expected valid token, got %v", err)
	}
	if id.UserID != "42" || id.Username != "streamer" || id.Email != "streamer@example.com" {
		t.Fatalf("unexpected identity: %+v", id)
	}

	expired := makeTestToken(t, secret, "42", "streamer@example.com", time.Now().Add(-1*time.Minute))
	if _, err := VerifyToken(expired, secret); err == nil {
		t.Fatal("expected expired token error")
	}

	if _, err := VerifyToken(valid, "wrong-secret"); err == nil {
		t.Fatal("expected wrong secret error")
	}
}

func TestWebSocketChatRoomFlow(t *testing.T) {
	const secret = "test-secret-key"
	hub := NewHub(2)
	srv := httptest.NewServer(newHTTPHandler(hub, secret))
	defer srv.Close()

	wsBase := "ws" + strings.TrimPrefix(srv.URL, "http") + "/ws"

	// Invalid token is rejected with 401 before upgrade.
	_, resp, err := websocket.DefaultDialer.Dial(wsBase+"?room=live/test&token=bad", nil)
	if err == nil {
		t.Fatal("expected dial failure for invalid token")
	}
	if resp == nil || resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("expected 401 status, got %v", resp)
	}

	// Guest connects and receives initial history + presence.
	guestConn, _, err := websocket.DefaultDialer.Dial(wsBase+"?room=live/test", nil)
	if err != nil {
		t.Fatalf("guest dial failed: %v", err)
	}
	defer guestConn.Close()

	var initEvt ServerEvent
	if err := guestConn.ReadJSON(&initEvt); err != nil {
		t.Fatalf("guest read init failed: %v", err)
	}
	if initEvt.Type != "history" || initEvt.Room != "live/test" || initEvt.Online != 1 {
		t.Fatalf("unexpected init event: %+v", initEvt)
	}

	// Authenticated user connects.
	tok := makeTestToken(t, secret, "7", "alice@example.com", time.Now().Add(time.Hour))
	authConn, _, err := websocket.DefaultDialer.Dial(wsBase+"?room=live/test&token="+tok, nil)
	if err != nil {
		t.Fatalf("auth dial failed: %v", err)
	}
	defer authConn.Close()

	// Drain presence event on guest and history event on authConn.
	var evt ServerEvent
	if err := guestConn.ReadJSON(&evt); err != nil || evt.Type != "presence" || evt.Online != 2 {
		t.Fatalf("expected presence online=2 on guest, got %+v (err=%v)", evt, err)
	}
	if err := authConn.ReadJSON(&evt); err != nil || evt.Type != "history" {
		t.Fatalf("expected history on authConn, got %+v (err=%v)", evt, err)
	}

	// Authenticated user sends a message; guest receives it.
	if err := authConn.WriteJSON(map[string]string{"type": "message", "text": "Привет чат!"}); err != nil {
		t.Fatalf("auth send failed: %v", err)
	}

	var msg ChatMessage
	if err := guestConn.ReadJSON(&msg); err != nil {
		t.Fatalf("guest read broadcast failed: %v", err)
	}
	if msg.Type != "message" || msg.Username != "alice" || msg.Text != "Привет чат!" {
		t.Fatalf("unexpected broadcast message: %+v", msg)
	}

	// Guest trying to send gets an error event.
	if err := guestConn.WriteJSON(map[string]string{"type": "message", "text": "hack"}); err != nil {
		t.Fatalf("guest write failed: %v", err)
	}
	var errEvt ServerEvent
	if err := guestConn.ReadJSON(&errEvt); err != nil || errEvt.Type != "error" {
		t.Fatalf("expected error event for guest, got %+v (err=%v)", errEvt, err)
	}

	// Health endpoint reflects active room.
	healthResp, err := http.Get(srv.URL + "/health")
	if err != nil {
		t.Fatalf("health request failed: %v", err)
	}
	defer healthResp.Body.Close()
	var health map[string]any
	if err := json.NewDecoder(healthResp.Body).Decode(&health); err != nil {
		t.Fatalf("decode health failed: %v", err)
	}
	if health["status"] != "ok" {
		t.Fatalf("unexpected health status: %+v", health)
	}
}
