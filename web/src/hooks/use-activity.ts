import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { listActivity, undoActivity } from '@pontis/api/endpoints/activity';

export function useActivity(spaceId: string | undefined) {
  return useQuery({
    queryKey: ['spaces', spaceId, 'activity'],
    queryFn: () => listActivity(spaceId!),
    enabled: !!spaceId,
    staleTime: 30_000,
  });
}

/**
 * Undo one ChangeSet through the server-side undo endpoint. Success
 * invalidates the activity feed and node tree; error mapping (review
 * required / expired / not undoable) stays in the page component.
 */
export function useUndoActivity(spaceId: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ changeSetId }: { changeSetId: string }) =>
      undoActivity(spaceId!, changeSetId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['spaces', spaceId, 'activity'] });
      qc.invalidateQueries({ queryKey: ['spaces', spaceId, 'nodes'] });
    },
  });
}

// --- browsing activity analysis (core/activity) ---
//
// The extension uploads replace-per-day batches of day × host aggregates;
// these hooks read them back for the /activity page. Filters are part of the
// query key, so a filtered view is one the user can bookmark and return to.

import { getActivityHosts, getActivityOverview } from '@pontis/api/endpoints/activity';
import type { ActivityQuery } from '@pontis/api';

export const ACTIVITY_HOST_PAGE_SIZE = 20;

export function useBrowsingOverview(params: ActivityQuery) {
  return useQuery({
    queryKey: ['browsing-activity', 'overview', params],
    queryFn: () => getActivityOverview(params),
    staleTime: 30_000,
  });
}

export function useBrowsingHosts(params: ActivityQuery) {
  return useInfiniteQuery({
    queryKey: ['browsing-activity', 'hosts', params],
    queryFn: ({ pageParam }) =>
      getActivityHosts({ ...params, limit: ACTIVITY_HOST_PAGE_SIZE, offset: pageParam as number }),
    initialPageParam: 0,
    getNextPageParam: (lastPage, pages) => {
      const seen = pages.reduce((n, p) => n + p.items.length, 0);
      return seen < lastPage.total ? seen : undefined;
    },
    staleTime: 30_000,
  });
}
