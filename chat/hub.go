package main

import (
	"encoding/json"
	"sync"
)

// ChatMessage represents a single chat message broadcast to a room.
type ChatMessage struct {
	Type      string `json:"type"`
	ID        string `json:"id"`
	Room      string `json:"room"`
	UserID    string `json:"user_id"`
	Username  string `json:"username"`
	Text      string `json:"text"`
	CreatedAt string `json:"created_at"`
}

// ServerEvent represents non-chat control/state payloads sent to clients.
type ServerEvent struct {
	Type     string        `json:"type"`
	Room     string        `json:"room,omitempty"`
	Messages []ChatMessage `json:"messages,omitempty"`
	Online   int           `json:"online,omitempty"`
	Message  string        `json:"message,omitempty"`
}

type roomState struct {
	clients map[*Client]struct{}
	history []ChatMessage
}

// Hub manages WebSocket clients, room membership, and per-room message history.
type Hub struct {
	mu           sync.RWMutex
	rooms        map[string]*roomState
	historyLimit int
}

func NewHub(historyLimit int) *Hub {
	if historyLimit <= 0 {
		historyLimit = 50
	}
	return &Hub{
		rooms:        make(map[string]*roomState),
		historyLimit: historyLimit,
	}
}

func (h *Hub) getOrCreateRoomLocked(room string) *roomState {
	rs, ok := h.rooms[room]
	if !ok {
		rs = &roomState{
			clients: make(map[*Client]struct{}),
		}
		h.rooms[room] = rs
	}
	return rs
}

// Register adds a client to its room, returns recent history and current online count,
// and notifies other clients in the room about the updated presence.
func (h *Hub) Register(c *Client) ([]ChatMessage, int) {
	h.mu.Lock()
	rs := h.getOrCreateRoomLocked(c.room)
	others := snapshotClients(rs.clients)
	rs.clients[c] = struct{}{}
	history := make([]ChatMessage, len(rs.history))
	copy(history, rs.history)
	online := len(rs.clients)
	h.mu.Unlock()

	h.sendPresence(c.room, online, others)
	return history, online
}

// Unregister removes a client from its room and broadcasts updated presence.
func (h *Hub) Unregister(c *Client) {
	h.mu.Lock()
	rs, ok := h.rooms[c.room]
	if !ok {
		h.mu.Unlock()
		return
	}
	if _, exists := rs.clients[c]; !exists {
		h.mu.Unlock()
		return
	}
	delete(rs.clients, c)
	c.closeSend()
	online := len(rs.clients)
	targets := snapshotClients(rs.clients)
	h.mu.Unlock()

	h.sendPresence(c.room, online, targets)
}

// BroadcastMessage stores a message in room history and sends it to all room members.
func (h *Hub) BroadcastMessage(room string, msg ChatMessage) {
	payload, err := json.Marshal(msg)
	if err != nil {
		return
	}

	h.mu.Lock()
	rs := h.getOrCreateRoomLocked(room)
	rs.history = append(rs.history, msg)
	if len(rs.history) > h.historyLimit {
		rs.history = rs.history[len(rs.history)-h.historyLimit:]
	}
	targets := snapshotClients(rs.clients)
	h.mu.Unlock()

	h.deliver(targets, payload)
}

// RoomStats returns active rooms and their connected viewer counts.
func (h *Hub) RoomStats() map[string]int {
	h.mu.RLock()
	defer h.mu.RUnlock()
	stats := make(map[string]int, len(h.rooms))
	for name, rs := range h.rooms {
		if len(rs.clients) > 0 {
			stats[name] = len(rs.clients)
		}
	}
	return stats
}

func (h *Hub) sendPresence(room string, online int, targets []*Client) {
	if len(targets) == 0 {
		return
	}
	payload, err := json.Marshal(ServerEvent{
		Type:   "presence",
		Room:   room,
		Online: online,
	})
	if err != nil {
		return
	}
	h.deliver(targets, payload)
}

func (h *Hub) deliver(targets []*Client, payload []byte) {
	for _, client := range targets {
		if !client.trySend(payload) {
			h.Unregister(client)
		}
	}
}

func snapshotClients(clients map[*Client]struct{}) []*Client {
	list := make([]*Client, 0, len(clients))
	for c := range clients {
		list = append(list, c)
	}
	return list
}
