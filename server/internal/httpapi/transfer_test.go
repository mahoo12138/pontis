package httpapi

import (
	"net/http"
	"strings"
	"testing"
)

func TestTransferExportImportRoundTrip(t *testing.T) {
	f := bootstrapLibraryFlow(t)
	h := map[string]string{"Authorization": "Bearer " + f.sessionToken}
	root := f.ts.URL + "/api/v1/spaces/" + f.spaceID

	// Seed a folder with two bookmarks.
	code, body := doJSON(t, "POST", root+"/nodes", h, map[string]any{
		"type": "folder", "title": "开发", "parent": map[string]string{"type": "root", "key": "main"},
	})
	if code != http.StatusCreated {
		t.Fatalf("folder = %d %v", code, body)
	}
	folderID := body["id"].(string)
	for _, u := range []string{"https://go.dev", "https://github.com"} {
		code, body = doJSON(t, "POST", root+"/nodes", h, map[string]any{
			"type": "bookmark", "title": u, "url": u,
			"parent": map[string]string{"type": "node", "id": folderID},
		})
		if code != http.StatusCreated {
			t.Fatalf("bookmark %s = %d %v", u, code, body)
		}
	}

	// Export as Netscape HTML: hierarchy and links present.
	code, body = doJSON(t, "POST", root+"/export", h, map[string]string{"format": "netscape_html"})
	if code != http.StatusOK {
		t.Fatalf("export html = %d %v", code, body)
	}
	html := body["content"].(string)
	if !strings.Contains(html, "<DT><H3>开发</H3>") || !strings.Contains(html, `HREF="https://go.dev"`) {
		t.Fatalf("html export missing content: %.200s", html)
	}

	// Export as Native JSON.
	code, body = doJSON(t, "POST", root+"/export", h, map[string]string{"format": "native_json"})
	if code != http.StatusOK {
		t.Fatalf("export json = %d %v", code, body)
	}
	jsonContent := body["content"].(string)
	if !strings.Contains(jsonContent, "pontis-portable-bookmarks") {
		t.Fatalf("json export wrong format: %.120s", jsonContent)
	}

	// Preview an import of the HTML export into the same space: everything kept.
	code, body = doJSON(t, "POST", root+"/import/preview", h,
		map[string]string{"format": "netscape_html", "content": html})
	if code != http.StatusOK {
		t.Fatalf("preview = %d %v", code, body)
	}
	planID := body["plan_id"].(string)
	if body["counts"].(map[string]any)["keep"].(float64) < 3 {
		t.Fatalf("expected keeps in plan, got %v", body["counts"])
	}

	// Garbage content is rejected.
	code, body = doJSON(t, "POST", root+"/import/preview", h,
		map[string]string{"format": "netscape_html", "content": "this is not html"})
	if code != http.StatusBadRequest || errCode(t, body) != "INVALID_IMPORT" {
		t.Fatalf("garbage preview = %d %v", code, body)
	}

	// Apply as merge into root: keeps all matched, creates nothing.
	code, body = doJSON(t, "POST", root+"/import/apply", h,
		map[string]any{"plan_id": planID, "parent": map[string]string{"type": "root", "key": "main"}, "strategy": "merge"})
	if code != http.StatusOK || body["created"].(float64) != 0 {
		t.Fatalf("merge apply = %d %v", code, body)
	}

	// Stale plan protection: reuse the consumed plan id.
	code, body = doJSON(t, "POST", root+"/import/apply", h,
		map[string]any{"plan_id": planID, "parent": map[string]string{"type": "root", "key": "main"}, "strategy": "merge"})
	if code != http.StatusNotFound || errCode(t, body) != "PLAN_NOT_FOUND" {
		t.Fatalf("consumed plan reuse = %d %v", code, body)
	}

	// Replace import into a fresh folder wipes the folder's previous content.
	code, body = doJSON(t, "POST", root+"/nodes", h, map[string]any{
		"type": "folder", "title": "替换目标", "parent": map[string]string{"type": "root", "key": "main"},
	})
	if code != http.StatusCreated {
		t.Fatalf("target folder = %d %v", code, body)
	}
	targetID := body["id"].(string)
	code, body = doJSON(t, "POST", root+"/nodes", h, map[string]any{
		"type": "bookmark", "title": "will be wiped", "url": "https://wipe.example",
		"parent": map[string]string{"type": "node", "id": targetID},
	})
	if code != http.StatusCreated {
		t.Fatalf("wipee = %d %v", code, body)
	}

	code, body = doJSON(t, "POST", root+"/import/preview", h,
		map[string]string{"format": "native_json", "content": jsonContent})
	if code != http.StatusOK {
		t.Fatalf("json preview = %d %v", code, body)
	}
	planID = body["plan_id"].(string)
	code, body = doJSON(t, "POST", root+"/import/apply", h,
		map[string]any{"plan_id": planID, "parent": map[string]string{"type": "node", "id": targetID}, "strategy": "replace"})
	if code != http.StatusOK {
		t.Fatalf("replace apply = %d %v", code, body)
	}
	if body["created"].(float64) != 3 || body["deleted"].(float64) != 1 {
		t.Fatalf("replace counters = %v, want created=3 deleted=1", body)
	}

	// The target folder now holds the imported subtree: one folder whose
	// two bookmarks live beneath it.
	code, body = doJSON(t, "GET", root+"/nodes", h, nil)
	if code != http.StatusOK {
		t.Fatalf("nodes = %d %v", code, body)
	}
	inTarget := 0
	titles := map[string]bool{}
	for _, n := range body["nodes"].([]any) {
		m := n.(map[string]any)
		if m["parent_id"] == targetID {
			inTarget++
		}
		titles[m["title"].(string)] = true
	}
	if inTarget != 1 {
		t.Fatalf("target children = %d, want 1 folder", inTarget)
	}
	for _, want := range []string{"开发", "https://go.dev", "https://github.com"} {
		if !titles[want] {
			t.Fatalf("imported node %q missing", want)
		}
	}
	if titles["will be wiped"] {
		t.Fatalf("replace left the old child behind")
	}
}

// An apply whose target the client cannot resolve (a bare 'root:' placeholder
// or a node id that is not a folder) is a client error, not a server fault:
// the web import modal can send it while its location select is still
// settling. Same contract the plaza apply already pins down.
func TestTransferApplyRejectsUnknownTargetParent(t *testing.T) {
	f := bootstrapLibraryFlow(t)
	h := map[string]string{"Authorization": "Bearer " + f.sessionToken}
	root := f.ts.URL + "/api/v1/spaces/" + f.spaceID

	code, body := doJSON(t, "POST", root+"/import/preview", h,
		map[string]string{"format": "netscape_html", "content": "<!DOCTYPE NETSCAPE-Bookmark-file-1>\n<HTML><HEAD><TITLE>x</TITLE></HEAD>\n<BODY><DL><p>\n<DT><A HREF=\"https://go.dev/\">x</A>\n</DL><p>\n</BODY></HTML>"})
	if code != http.StatusOK {
		t.Fatalf("preview = %d %v", code, body)
	}
	planID := body["plan_id"].(string)

	code, body = doJSON(t, "POST", root+"/import/apply", h,
		map[string]any{"plan_id": planID, "parent": map[string]string{"type": "root"}, "strategy": "merge"})
	if code != http.StatusNotFound || errCode(t, body) != "ROOT_SLOT_NOT_FOUND" {
		t.Fatalf("apply with empty root key = %d %v, want 404 ROOT_SLOT_NOT_FOUND", code, body)
	}

	code, body = doJSON(t, "POST", root+"/import/apply", h,
		map[string]any{"plan_id": planID, "parent": map[string]string{"type": "node", "id": "does-not-exist"}, "strategy": "merge"})
	if code != http.StatusNotFound || errCode(t, body) != "NODE_NOT_FOUND" {
		t.Fatalf("apply with unknown node parent = %d %v, want 404 NODE_NOT_FOUND", code, body)
	}

	// The plan survives both refused applies: nothing was written, so the
	// caller can retry with a corrected location.
	code, body = doJSON(t, "POST", root+"/import/apply", h,
		map[string]any{"plan_id": planID, "parent": map[string]string{"type": "root", "key": "main"}, "strategy": "merge"})
	if code != http.StatusOK {
		t.Fatalf("apply after refused targets = %d %v", code, body)
	}
}

// Regression test for R38, R39, R41, R42: entity round-trip, empty folders,
// root-slot export including nested subtrees, replace preview delete counts,
// and automatic safety backup on root-level replace.
func TestTransferEntitiesRootSlotExportEmptyFoldersAndReplacePreview(t *testing.T) {
	f := bootstrapLibraryFlow(t)
	h := map[string]string{"Authorization": "Bearer " + f.sessionToken}
	root := f.ts.URL + "/api/v1/spaces/" + f.spaceID

	// Create: Empty folder A, folder B ("Q&A") with nested bookmark ("a.com/?x=1&y=2"),
	// and a trailing top-level bookmark.
	code, body := doJSON(t, "POST", root+"/nodes", h, map[string]any{
		"type": "folder", "title": "EmptyA", "parent": map[string]string{"type": "root", "key": "main"},
	})
	if code != http.StatusCreated {
		t.Fatalf("EmptyA = %d %v", code, body)
	}
	code, body = doJSON(t, "POST", root+"/nodes", h, map[string]any{
		"type": "folder", "title": `Q&A "Docs"`, "parent": map[string]string{"type": "root", "key": "main"},
	})
	if code != http.StatusCreated {
		t.Fatalf("Q&A = %d %v", code, body)
	}
	qaID := body["id"].(string)
	code, body = doJSON(t, "POST", root+"/nodes", h, map[string]any{
		"type": "bookmark", "title": "Search & Filter", "url": "https://a.com/?x=1&y=2",
		"parent": map[string]string{"type": "node", "id": qaID},
	})
	if code != http.StatusCreated {
		t.Fatalf("nested bookmark = %d %v", code, body)
	}
	code, body = doJSON(t, "POST", root+"/nodes", h, map[string]any{
		"type": "bookmark", "title": "Trailing", "url": "https://trailing.example",
		"parent": map[string]string{"type": "root", "key": "main"},
	})
	if code != http.StatusCreated {
		t.Fatalf("trailing = %d %v", code, body)
	}

	// R39: Export scoped to root_key="main" MUST include nested folder contents!
	code, body = doJSON(t, "POST", root+"/export", h, map[string]string{"format": "netscape_html", "root_key": "main"})
	if code != http.StatusOK {
		t.Fatalf("root export html = %d %v", code, body)
	}
	exportedHTML := body["content"].(string)
	if !strings.Contains(exportedHTML, "https://a.com/?x=1&amp;y=2") {
		t.Fatalf("root-slot HTML export lost nested bookmark: %s", exportedHTML)
	}

	code, body = doJSON(t, "POST", root+"/export", h, map[string]string{"format": "native_json", "root_key": "main"})
	if code != http.StatusOK {
		t.Fatalf("root export json = %d %v", code, body)
	}
	// Go's json.Marshal escapes '&' as \u0026; verify via real JSON round-trip preview.
	code, jsonPrev := doJSON(t, "POST", root+"/import/preview", h, map[string]any{
		"format": "native_json", "content": body["content"].(string),
	})
	if code != http.StatusOK || jsonPrev["total"].(float64) != 4 {
		t.Fatalf("root-slot JSON export lost nested bookmark: preview=%d %v", code, jsonPrev)
	}

	// R38: Previewing the exported HTML against the same space matches existing
	// entities (keep=4, create=0) instead of corrupting & into &amp;.
	code, body = doJSON(t, "POST", root+"/import/preview", h, map[string]any{
		"format": "netscape_html", "content": exportedHTML,
	})
	if code != http.StatusOK {
		t.Fatalf("entity preview = %d %v", code, body)
	}
	counts := body["counts"].(map[string]any)
	if counts["keep"].(float64) != 4 || counts["create"] != nil {
		t.Fatalf("entity preview counts = %v, want keep=4 create=0", counts)
	}

	// R42: Replace preview reports deleted nodes up front.
	code, body = doJSON(t, "POST", root+"/import/preview", h, map[string]any{
		"format": "netscape_html", "content": exportedHTML,
		"strategy": "replace", "parent": map[string]string{"type": "root", "key": "main"},
	})
	if code != http.StatusOK {
		t.Fatalf("replace preview = %d %v", code, body)
	}
	counts = body["counts"].(map[string]any)
	if counts["delete"].(float64) != 4 || counts["create"].(float64) != 4 {
		t.Fatalf("replace preview counts = %v, want delete=4 create=4", counts)
	}
	planID := body["plan_id"].(string)

	// Apply replace at root: creates a safety backup and preserves empty folder + sibling hierarchy (R41).
	code, body = doJSON(t, "POST", root+"/import/apply", h, map[string]any{
		"plan_id": planID, "parent": map[string]string{"type": "root", "key": "main"}, "strategy": "replace",
	})
	if code != http.StatusOK {
		t.Fatalf("replace apply = %d %v", code, body)
	}
	if body["deleted"].(float64) != 4 || body["created"].(float64) != 4 {
		t.Fatalf("replace apply counters = %v, want deleted=4 created=4", body)
	}

	// Verify safety backup was captured before root replace.
	code, body = doJSON(t, "GET", root+"/backups", h, nil)
	if code != http.StatusOK {
		t.Fatalf("backups = %d %v", code, body)
	}
	backups, _ := body["backups"].([]any)
	if len(backups) != 1 || backups[0].(map[string]any)["kind"] != "safety" {
		t.Fatalf("expected 1 safety backup after root replace, got %v", backups)
	}

	// Verify restored tree structure: EmptyA has 0 children, Q&A "Docs" is a
	// sibling at root with Search & Filter (exact URL with &), Trailing is at root.
	code, body = doJSON(t, "GET", root+"/nodes", h, nil)
	if code != http.StatusOK {
		t.Fatalf("nodes after roundtrip = %d %v", code, body)
	}
	var rootEmptyA, rootQA, nestedBM, rootTrailing map[string]any
	for _, raw := range body["nodes"].([]any) {
		n := raw.(map[string]any)
		switch n["title"] {
		case "EmptyA":
			rootEmptyA = n
		case `Q&A "Docs"`:
			rootQA = n
		case "Search & Filter":
			nestedBM = n
		case "Trailing":
			rootTrailing = n
		}
	}
	if rootEmptyA == nil || rootEmptyA["root_key"] != "main" {
		t.Fatalf("EmptyA wrong: %v", rootEmptyA)
	}
	if rootQA == nil || rootQA["root_key"] != "main" {
		t.Fatalf("Q&A swallowed by EmptyA: %v", rootQA)
	}
	if nestedBM == nil || nestedBM["parent_id"] != rootQA["id"] || nestedBM["url"] != "https://a.com/?x=1&y=2" {
		t.Fatalf("nested bookmark wrong after roundtrip: %v", nestedBM)
	}
	if rootTrailing == nil || rootTrailing["root_key"] != "main" {
		t.Fatalf("Trailing swallowed by empty folder: %v", rootTrailing)
	}
}
