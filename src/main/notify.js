// Notifications from the agents ("Pack JL-EXP-1115-01 is ready to sign").
// Each one goes to the screens as a 'notify' event, and to the system as a desktop notification
// when the window is not in front. Services may report the same message twice (a notify() call and
// a 'notify' event), so a title + text seen in the last few seconds is shown only once.

export function normalizeNotice(input) {
  if (typeof input === 'string') return { title: 'Jewel Labs', body: input };
  const n = input && typeof input === 'object' ? input : {};
  return {
    ...n,
    title: String(n.title || 'Jewel Labs'),
    body: String(n.body ?? n.message ?? n.text ?? ''),
  };
}

export function createNotifier({
  Notification,
  sendEvent = () => {},
  isWindowFocused = () => false,
  isEnabled = () => true,
  onClick = () => {},
  now = Date.now,
  repeatMs = 5000,
}) {
  const recent = new Map(); // "title\nbody" -> time last shown
  const showing = new Set(); // keep references so notifications are not garbage collected early

  function notify(input) {
    const notice = normalizeNotice(input);
    const key = `${notice.title}\n${notice.body}`;
    const t = now();
    if (recent.has(key) && t - recent.get(key) < repeatMs) return false;
    recent.set(key, t);
    for (const [k, at] of recent) if (t - at > repeatMs) recent.delete(k);

    sendEvent('notify', notice);
    if (!isWindowFocused() && isEnabled() && Notification?.isSupported?.()) {
      const n = new Notification({ title: notice.title, body: notice.body });
      showing.add(n);
      n.on('click', () => onClick(notice));
      n.on('close', () => showing.delete(n));
      n.show();
    }
    return true;
  }

  return { notify };
}
