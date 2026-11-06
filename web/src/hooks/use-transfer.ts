import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  previewImport,
  applyImport,
  exportSpace,
} from '@pontis/api/endpoints/transfer';
import type {
  ExportRequest,
  ImportApplyRequest,
  ImportPreviewRequest,
} from '@pontis/api';

export function useImportPreview(spaceId: string | undefined) {
  return useMutation({
    mutationFn: (params: ImportPreviewRequest) => previewImport(spaceId!, params),
  });
}

export function useImportApply(spaceId: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (params: ImportApplyRequest) => applyImport(spaceId!, params),
    onSuccess: () => {
      // Same contract as use-node-crud: every write invalidates the space's
      // node list, or the explorer keeps showing the pre-import tree until
      // the cache happens to go stale.
      qc.invalidateQueries({ queryKey: ['spaces', spaceId, 'nodes'] });
    },
  });
}

export function useExport(spaceId: string | undefined) {
  return useMutation({
    mutationFn: (params: ExportRequest) => exportSpace(spaceId!, params),
  });
}
