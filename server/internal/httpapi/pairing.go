package httpapi

// Pairing-code endpoints: the web console mints a code for a signed-in user,
// the extension redeems it for a device credential. Redemption is public —
// the redeemer holds no credential yet, the code is the credential — and the
// response mirrors POST /devices so one client-side registration code path
// serves both.

import (
	"errors"
	"net/http"
	"time"

	"pontis/internal/device"
)

type pairingCodeResponse struct {
	Code      string    `json:"code"`
	ExpiresAt time.Time `json:"expires_at"`
}

// handleCreatePairingCode mints a code the web console shows for the user to
// type into the extension.
func (s *Server) handleCreatePairingCode(w http.ResponseWriter, r *http.Request) {
	u, _ := currentUser(r)
	code, expiresAt, err := s.Devices.CreatePairingCode(r.Context(), u.ID)
	if err != nil {
		s.writeError(w, r, http.StatusInternalServerError, "INTERNAL", "internal error")
		return
	}
	writeJSON(w, http.StatusCreated, pairingCodeResponse{Code: code, ExpiresAt: expiresAt})
}

type pairWithCodeRequest struct {
	Code       string `json:"code"`
	Name       string `json:"name"`
	ClientType string `json:"client_type"`
	Browser    string `json:"browser"`
	Platform   string `json:"platform"`
}

// handlePairWithCode redeems a code for a device credential. Same response
// shape as handleRegisterDevice, so the extension's pairing code treats the
// two identically from here on.
func (s *Server) handlePairWithCode(w http.ResponseWriter, r *http.Request) {
	var req pairWithCodeRequest
	if !decodeJSON(w, r, &req) {
		return
	}
	if req.Name == "" {
		s.writeError(w, r, http.StatusBadRequest, "INVALID_NAME", "device name must not be empty")
		return
	}
	if req.ClientType == "" {
		req.ClientType = "extension"
	}

	dev, secret, err := s.Devices.PairWithCode(r.Context(),
		req.Code, req.Name, req.ClientType, req.Browser, req.Platform)
	if err != nil {
		switch {
		case errors.Is(err, device.ErrPairingCodeInvalid):
			s.writeError(w, r, http.StatusForbidden, "PAIRING_CODE_INVALID",
				"this pairing code is unknown, expired or already used")
		case errors.Is(err, device.ErrPairingUnavailable):
			s.writeError(w, r, http.StatusInternalServerError, "INTERNAL", "internal error")
		default:
			s.writeError(w, r, http.StatusInternalServerError, "INTERNAL", "internal error")
		}
		return
	}
	writeJSON(w, http.StatusCreated, registerDeviceResponse{
		Device: fromDevice(dev),
		Token:  secret,
	})
}
