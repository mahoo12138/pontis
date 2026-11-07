import { client } from '../client';
import { checkDeviceOverviewResponse, checkPairingCode, checkRegisterDevice } from '../contract';
import type {
  DeviceOverviewResponse,
  PairWithCodeRequest,
  PairingCodeResponse,
  RegisterDeviceRequest,
  RegisterDeviceResponse,
} from '../types';

export function registerDevice(params: RegisterDeviceRequest) {
  return client.post<RegisterDeviceResponse>('/devices', params, checkRegisterDevice);
}

/**
 * Mint a one-time pairing code for the signed-in user. The web console shows
 * it; a client that cannot hold a web session redeems it with pairWithCode.
 */
export function createPairingCode() {
  return client.post<PairingCodeResponse>('/devices/pairing-codes', {}, checkPairingCode);
}

/** Redeem a pairing code for a device credential — same response as /devices. */
export function pairWithCode(params: PairWithCodeRequest) {
  return client.post<RegisterDeviceResponse>('/devices/pair', params, checkRegisterDevice);
}

export function listDeviceOverview() {
  return client.get<DeviceOverviewResponse>('/devices/overview', checkDeviceOverviewResponse);
}

/** Stop a device without erasing it: it stays listed as revoked until the owner
 *  deletes it. */
export function revokeDevice(deviceId: string) {
  return client.post<void>(`/devices/${deviceId}/revoke`);
}

/** Remove a revoked device's record. The server refuses a live device. */
export function deleteDevice(deviceId: string) {
  return client.delete<void>(`/devices/${deviceId}`);
}
