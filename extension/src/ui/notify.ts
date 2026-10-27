// What an action's failure looks like on every extension surface.
//
// It used to be a banner pinned above the page: it pushed the section the person
// was working in out of the way, stayed until dismissed even after the problem
// had been fixed, and was rendered twice on the start-page tab — once on the
// page and once inside its dialog. A corner notification says the same thing
// without moving the page.

import { notifications } from '@mantine/notifications';

/**
 * Pinned rather than timed out: a rejected credential or an unreadable folder is
 * usually still true a minute later, and a toast that fades would take the only
 * notice of it away. The shared id replaces the previous failure instead of
 * stacking one toast per attempt, which is what the banner did.
 */
export function notifyError(message: string, title = '操作未完成'): void {
  notifications.show({
    id: 'pontis-action-error',
    title,
    message,
    color: 'errorRed',
    autoClose: false,
    withCloseButton: true,
  });
}
