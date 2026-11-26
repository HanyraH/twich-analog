package main

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/gorilla/websocket"
)

const (
	writeWait      = 10 * time.Second
	pongWait       = 60 * time.Second
	pingPeriod     = (pongWait * 9) / 10
	maxMessageSize = 2048
	maxTextRunes   = 500
	rateWindow     = 3 * time.Second
	rateMaxMsgs    = 5
)

type incomingPayload struct {
	Type string `json:"type"`
	Text string `json:"text"`
}

// Client represents a single WebSocket connection in a chat room.
type Client struct {
	hub       *Hub
	conn      *websocket.Conn
	send      chan []byte
	room      string
	user      *UserIdentity
	sendMu    sync.Mutex
	closed    bool
	recentMsg []time.Time
}

func NewClient(hub *Hub, conn *websocket.Conn, room string, user *UserIdentity) *Client {
	return &Client{
		hub:  hub,
		conn: conn,
		send: make(chan []byte, 64),
		room: room,
		user: user,
	}
}

func (c *Client) trySend(payload []byte) bool {
	c.sendMu.Lock()
	defer c.sendMu.Unlock()
	if c.closed {
		return false
	}
	select {
	case c.send <- payload:
		return true
	default:
		return false
	}
}

func (c *Client) closeSend() {
	c.sendMu.Lock()
	defer c.sendMu.Unlock()
	if !c.closed {
		c.closed = true
		close(c.send)
	}
}

func (c *Client) sendError(message string) {
	payload, err := json.Marshal(ServerEvent{
		Type:    "error",
		Room:    c.room,
		Message: message,
	})
	if err != nil {
		return
	}
	c.trySend(payload)
}

func (c *Client) allowMessage(now time.Time) bool {
	cutoff := now.Add(-rateWindow)
	kept := c.recentMsg[:0]
	for _, ts := range c.recentMsg {
		if ts.After(cutoff) {
			kept = append(kept, ts)
		}
	}
	c.recentMsg = kept
	if len(c.recentMsg) >= rateMaxMsgs {
		return false
	}
	c.recentMsg = append(c.recentMsg, now)
	return true
}

func (c *Client) readPump() {
	defer func() {
		c.hub.Unregister(c)
		_ = c.conn.Close()
	}()

	c.conn.SetReadLimit(maxMessageSize)
	_ = c.conn.SetReadDeadline(time.Now().Add(pongWait))
	c.conn.SetPongHandler(func(string) error {
		return c.conn.SetReadDeadline(time.Now().Add(pongWait))
	})

	for {
		_, raw, err := c.conn.ReadMessage()
		if err != nil {
			break
		}

		if c.user == nil {
			c.sendError("Войдите в аккаунт, чтобы писать в чат")
			continue
		}

		var incoming incomingPayload
		text := ""
		if err := json.Unmarshal(raw, &incoming); err == nil {
			if incoming.Type != "" && incoming.Type != "message" {
				continue
			}
			text = incoming.Text
		} else {
			text = string(raw)
		}

		text = strings.TrimSpace(text)
		if text == "" {
			continue
		}
		if utf8.RuneCountInString(text) > maxTextRunes {
			c.sendError("Сообщение слишком длинное (максимум 500 символов)")
			continue
		}

		now := time.Now().UTC()
		if !c.allowMessage(now) {
			c.sendError("Слишком много сообщений подряд, подождите пару секунд")
			continue
		}

		c.hub.BroadcastMessage(c.room, ChatMessage{
			Type:      "message",
			ID:        newMessageID(),
			Room:      c.room,
			UserID:    c.user.UserID,
			Username:  c.user.Username,
			Text:      text,
			CreatedAt: now.Format(time.RFC3339Nano),
		})
	}
}

func (c *Client) writePump() {
	ticker := time.NewTicker(pingPeriod)
	defer func() {
		ticker.Stop()
		_ = c.conn.Close()
	}()

	for {
		select {
		case message, ok := <-c.send:
			_ = c.conn.SetWriteDeadline(time.Now().Add(writeWait))
			if !ok {
				_ = c.conn.WriteMessage(websocket.CloseMessage, []byte{})
				return
			}
			if err := c.conn.WriteMessage(websocket.TextMessage, message); err != nil {
				return
			}
		case <-ticker.C:
			_ = c.conn.SetWriteDeadline(time.Now().Add(writeWait))
			if err := c.conn.WriteMessage(websocket.PingMessage, nil); err != nil {
				return
			}
		}
	}
}

func newMessageID() string {
	var b [8]byte
	if _, err := rand.Read(b[:]); err != nil {
		return time.Now().UTC().Format("20060102150405.000000")
	}
	return hex.EncodeToString(b[:])
}
