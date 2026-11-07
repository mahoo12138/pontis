import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  listDeviceOverview,
  revokeDevice,
  deleteDevice,
  registerDevice,
  createPairingCode,
} from '@pontis/api/endpoints/devices';
import type { RegisterDeviceRequest } from '@pontis/api';

export function useDeviceOverview() {
  return useQuery({
    queryKey: ['devices', 'overview'],
    queryFn: () => listDeviceOverview(),
    staleTime: 15_000,
  });
}

export function useRevokeDevice() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (deviceId: string) => revokeDevice(deviceId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['devices'] });
    },
  });
}

/** Remove a device record that has already been revoked. */
export function useDeleteDevice() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (deviceId: string) => deleteDevice(deviceId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['devices'] });
    },
  });
}

export function useRegisterDevice() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (params: RegisterDeviceRequest) => registerDevice(params),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['devices'] });
    },
  });
}

/**
 * Mint a one-time pairing code. Not cached: every open of the dialog mints a
 * fresh code, so a stale one never sits on screen past its own expiry.
 */
export function usePairingCode() {
  return useMutation({
    mutationFn: () => createPairingCode(),
  });
}
