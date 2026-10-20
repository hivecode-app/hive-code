// The company's one time zone (#121): `timezone` in company/org.yaml, as hq sends it in /api/board and
// /api/org ({name, offset_min}). Every hour and day the app shows ("14:02", "אתמול", "מאז 18/10", the hours
// on the lanes) is his, wherever the phone thinks it is. Until hq answers (and in the fake backend): the phone's.
//
// "Now" too comes from here: every place the app reads the time (the day separators, "מאז", "לפני 5 דק'",
// the lanes) calls CompanyTime.now(), so tests pin one clock and the goldens don't depend on the day they run (#125).
//
// The app carries no tz database: hq sends the offset in force now, and every board refreshes it. A timestamp
// from before a daylight-saving change can show an hour off; Asia/Bangkok, for one, has none.

class CompanyTime {
  CompanyTime._();

  /// Where "now" comes from. Tests pin it (test/helpers.dart `pinClock`); the app leaves it on the phone's clock.
  static DateTime Function() clock = DateTime.now;

  /// Now, by [clock].
  static DateTime now() => clock();

  /// The IANA name, e.g. Asia/Bangkok. Null: not heard from hq yet.
  static String? zone;

  /// Its offset from UTC now. Null: the phone's own zone.
  static Duration? offset;

  /// `timezone` of a board or org response; anything else leaves it as it was.
  static void apply(Object? j) {
    if (j is! Map) return;
    final m = j['offset_min'];
    if (m is! num) return;
    offset = Duration(minutes: m.toInt());
    zone = j['name'] is String ? j['name'] as String : null;
  }

  /// Back to the phone's zone (tests).
  static void reset() {
    zone = null;
    offset = null;
  }
}

/// [t] on his wall clock: read `.hour`, `.day`, `.weekday` of this, never of [t] itself.
DateTime wall(DateTime t) {
  final o = CompanyTime.offset;
  return o == null ? t.toLocal() : t.toUtc().add(o);
}

/// The instant his day of [t] starts.
DateTime dayStart(DateTime t) {
  final w = wall(t), o = CompanyTime.offset;
  return o == null ? DateTime(w.year, w.month, w.day) : DateTime.utc(w.year, w.month, w.day).subtract(o);
}

/// The instant the hour of [t] starts, [hours] hours later.
DateTime hourStart(DateTime t, [int hours = 0]) {
  final w = wall(t), o = CompanyTime.offset;
  return o == null ? DateTime(w.year, w.month, w.day, w.hour + hours) : DateTime.utc(w.year, w.month, w.day, w.hour + hours).subtract(o);
}

/// Calendar days from his day of [t] to his day of [now]: 0 today, 1 yesterday.
int daysAgo(DateTime t, DateTime now) {
  final a = wall(t), b = wall(now);
  // In UTC, so a daylight-saving night isn't 23 hours.
  return DateTime.utc(b.year, b.month, b.day).difference(DateTime.utc(a.year, a.month, a.day)).inDays;
}

/// "14:02" on his clock.
String hm(DateTime t) {
  final w = wall(t);
  return '${w.hour.toString().padLeft(2, '0')}:${w.minute.toString().padLeft(2, '0')}';
}

/// "18/10" on his calendar.
String dm(DateTime t) {
  final w = wall(t);
  return '${w.day}/${w.month}';
}
