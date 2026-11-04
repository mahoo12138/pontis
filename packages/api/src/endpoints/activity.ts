import { client } from '../client';
import { checkActivityHosts, checkActivityList, checkActivityOverview, checkUndoActivity } from '../contract';
import type {
  ActivityHostsResponse,
  ActivityListResponse,
  ActivityOverviewResponse,
  ActivityQuery,
  UndoActivityResult,
} from '../types';

export function listActivity(spaceId: string) {
  return client.get<ActivityListResponse>(`/spaces/${spaceId}/activity`, checkActivityList);
}

/**
 * Undo one ChangeSet. Resolves with the clean result; rejects with an
 * ApiError whose `details.reasons` explain review/expiry blockers
 * (REVIEW_REQUIRED, UNDO_EXPIRED, NOT_UNDOABLE, ALREADY_UNDONE).
 */
export function undoActivity(spaceId: string, changeSetId: string) {
  return client.post<UndoActivityResult>(
    `/spaces/${spaceId}/changesets/${changeSetId}/undo`,
    {},
    checkUndoActivity,
  );
}

// --- browsing activity analysis (core/activity) ---
//
// The extension uploads replace-per-day batches of day × host aggregates;
// these are the two reads the analysis page is built from. Both take the
// same filter shape — an inclusive local-day range and an optional device —
// and every filter is a query parameter, so a viewed range is a link the
// user can share or come back to.

function activityQuery(params: ActivityQuery): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== '') query.set(key, String(value));
  }
  const qs = query.toString();
  return qs ? `?${qs}` : '';
}

export function getActivityOverview(params: ActivityQuery = {}) {
  return client.get<ActivityOverviewResponse>(`/activity/overview${activityQuery(params)}`, checkActivityOverview);
}

export function getActivityHosts(params: ActivityQuery & { limit?: number; offset?: number } = {}) {
  return client.get<ActivityHostsResponse>(`/activity/hosts${activityQuery(params)}`, checkActivityHosts);
}
