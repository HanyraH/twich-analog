package main

import (
	"bufio"
	"errors"
	"os"
	"strings"

	"github.com/golang-jwt/jwt/v5"
)

type UserIdentity struct {
	UserID   string
	Email    string
	Username string
}

type tokenClaims struct {
	Email string `json:"email,omitempty"`
	jwt.RegisteredClaims
}

// LoadEnvFiles populates unset environment variables from simple KEY=VALUE files.
func LoadEnvFiles(paths ...string) {
	for _, p := range paths {
		f, err := os.Open(p)
		if err != nil {
			continue
		}
		scanner := bufio.NewScanner(f)
		for scanner.Scan() {
			line := strings.TrimSpace(scanner.Text())
			if line == "" || strings.HasPrefix(line, "#") {
				continue
			}
			idx := strings.IndexByte(line, '=')
			if idx <= 0 {
				continue
			}
			key := strings.TrimSpace(line[:idx])
			val := strings.TrimSpace(line[idx+1:])
			val = strings.Trim(val, `"'`)
			if key != "" && os.Getenv(key) == "" {
				_ = os.Setenv(key, val)
			}
		}
		_ = f.Close()
	}
}

// VerifyToken validates an HS256 JWT issued by the FastAPI auth backend.
func VerifyToken(tokenStr, secret string) (*UserIdentity, error) {
	if secret == "" {
		return nil, errors.New("jwt secret is not configured")
	}
	if tokenStr == "" {
		return nil, errors.New("empty token")
	}

	claims := &tokenClaims{}
	token, err := jwt.ParseWithClaims(
		tokenStr,
		claims,
		func(t *jwt.Token) (any, error) {
			return []byte(secret), nil
		},
		jwt.WithValidMethods([]string{"HS256"}),
		jwt.WithExpirationRequired(),
	)
	if err != nil || !token.Valid {
		return nil, errors.New("invalid or expired token")
	}

	if claims.Subject == "" {
		return nil, errors.New("missing subject claim")
	}

	username := "user_" + claims.Subject
	if claims.Email != "" {
		if at := strings.IndexByte(claims.Email, '@'); at > 0 {
			username = claims.Email[:at]
		} else {
			username = claims.Email
		}
	}

	return &UserIdentity{
		UserID:   claims.Subject,
		Email:    claims.Email,
		Username: username,
	}, nil
}
