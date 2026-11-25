package httpapi

import (
	"fmt"
	"math"
	"net"
	"net/http"
	"strings"
	"sync"
	"time"
)

// RateLimiter implements a bounded in-memory token bucket keyed by client IP
// or account identifier to absorb auth brute-force bursts (R21).
type RateLimiter struct {
	mu          sync.Mutex
	buckets     map[string]*tokenBucket
	lastSweep   time.Time
	nowFunc     func() time.Time
	ipBurst     int
	ipRefill    time.Duration
	acctBurst   int
	acctRefill  time.Duration
	maxIdleAge  time.Duration
}

type tokenBucket struct {
	tokens     float64
	lastRefill time.Time
	lastSeen   time.Time
}

// NewRateLimiter constructs a rate limiter with explicit burst and refill rates.
func NewRateLimiter(ipBurst int, ipRefill time.Duration, acctBurst int, acctRefill time.Duration) *RateLimiter {
	return &RateLimiter{
		buckets:    map[string]*tokenBucket{},
		nowFunc:    time.Now,
		ipBurst:    ipBurst,
		ipRefill:   ipRefill,
		acctBurst:  acctBurst,
		acctRefill: acctRefill,
		maxIdleAge: 15 * time.Minute,
	}
}

func defaultAuthRateLimiter() *RateLimiter {
	return NewRateLimiter(30, 2*time.Second, 15, 4*time.Second)
}

func (rl *RateLimiter) allow(key string, burst int, refillEvery time.Duration) (bool, time.Duration) {
	if rl == nil || burst <= 0 || refillEvery <= 0 {
		return true, 0
	}
	now := rl.nowFunc()
	rl.mu.Lock()
	defer rl.mu.Unlock()

	if now.Sub(rl.lastSweep) > time.Minute && len(rl.buckets) > 256 {
		for k, b := range rl.buckets {
			if now.Sub(b.lastSeen) > rl.maxIdleAge {
				delete(rl.buckets, k)
			}
		}
		rl.lastSweep = now
	}

	b, ok := rl.buckets[key]
	if !ok {
		b = &tokenBucket{tokens: float64(burst), lastRefill: now, lastSeen: now}
		rl.buckets[key] = b
	}
	elapsed := now.Sub(b.lastRefill)
	if elapsed > 0 {
		added := float64(elapsed) / float64(refillEvery)
		b.tokens = math.Min(float64(burst), b.tokens+added)
		b.lastRefill = now
	}
	b.lastSeen = now

	if b.tokens >= 1 {
		b.tokens -= 1
		return true, 0
	}
	missing := 1.0 - b.tokens
	wait := time.Duration(math.Ceil(missing * float64(refillEvery)))
	if wait < time.Second {
		wait = time.Second
	}
	return false, wait
}

func (rl *RateLimiter) AllowIP(ip string) (bool, time.Duration) {
	return rl.allow("ip:"+ip, rl.ipBurst, rl.ipRefill)
}

func (rl *RateLimiter) AllowAccount(account string) (bool, time.Duration) {
	return rl.allow("acct:"+strings.ToLower(strings.TrimSpace(account)), rl.acctBurst, rl.acctRefill)
}

func (s *Server) authLimiter() *RateLimiter {
	s.rateLimitOnce.Do(func() {
		if s.AuthRateLimit == nil {
			s.AuthRateLimit = defaultAuthRateLimiter()
		}
	})
	return s.AuthRateLimit
}

// clientIP extracts the caller's IP address. X-Forwarded-For is consulted only
// when the direct peer is in Deploy.Proxies so untrusted clients cannot spoof
// their rate-limit bucket.
func (s *Server) clientIP(r *http.Request) string {
	if s.Deploy.fromTrustedProxy(r) {
		if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
			if first := firstForwardedValue(xff); first != "" {
				return first
			}
		}
	}
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}

func (s *Server) rateLimitPublicAuth(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ok, retryAfter := s.authLimiter().AllowIP(s.clientIP(r))
		if !ok {
			w.Header().Set("Retry-After", fmt.Sprintf("%d", int(math.Ceil(retryAfter.Seconds()))))
			s.writeError(w, r, http.StatusTooManyRequests, "RATE_LIMITED", "too many requests, please retry later")
			return
		}
		next.ServeHTTP(w, r)
	})
}

// bodyLimitMiddleware bounds incoming request bodies to prevent memory
// exhaustion (R21). Bulk import and reconciliation snapshot uploads receive
// a larger 20 MiB budget; all other API endpoints are capped at 2 MiB.
func bodyLimitMiddleware(next http.Handler) http.Handler {
	const (
		defaultMaxBody = 2 << 20  // 2 MiB
		largeMaxBody   = 20 << 20 // 20 MiB
	)
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Body != nil && r.Body != http.NoBody {
			limit := int64(defaultMaxBody)
			p := r.URL.Path
			if strings.HasSuffix(p, "/import/preview") || strings.HasSuffix(p, "/client-snapshots") {
				limit = largeMaxBody
			}
			r.Body = http.MaxBytesReader(w, r.Body, limit)
		}
		next.ServeHTTP(w, r)
	})
}
