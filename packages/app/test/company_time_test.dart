// #121: the hours and days the app shows are org.yaml's `timezone` (from hq), not the phone's.
import 'package:agent_company/model/company_time.dart';
import 'package:agent_company/ui/blocks/since.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  tearDown(CompanyTime.reset);

  test('hq\'s zone moves every hour and day; the phone\'s zone does not matter', () {
    // 23:30 UTC on 20/10: 06:30 on 21/10 in Bangkok, 02:30 on 21/10 in Jerusalem, still 20/10 in London.
    final t = DateTime.utc(2026, 10, 20, 23, 30);
    CompanyTime.apply({'name': 'Asia/Bangkok', 'offset_min': 420});
    expect(CompanyTime.zone, 'Asia/Bangkok');
    expect(hm(t), '06:30');
    expect(dm(t), '21/10');
    expect(dayStart(t), DateTime.utc(2026, 10, 20, 17));
    expect(hourStart(t, 1), DateTime.utc(2026, 10, 21, 0));
    expect(daysAgo(DateTime.utc(2026, 10, 20, 16, 59), t), 1, reason: '23:59 the day before, in Bangkok');
    expect(daysAgo(DateTime.utc(2026, 10, 20, 17), t), 0);
    expect(sinceLabel(DateTime.utc(2026, 10, 20, 16), t), 'מאז אתמול 23:00');

    CompanyTime.apply({'name': 'Asia/Jerusalem', 'offset_min': 180});
    expect(hm(t), '02:30');
    expect(dayStart(t), DateTime.utc(2026, 10, 20, 21));
    expect(sinceLabel(DateTime.utc(2026, 10, 20, 16), t), 'מאז אתמול 19:00');

    CompanyTime.apply({'name': 'Europe/London', 'offset_min': 60});
    expect(dm(t), '21/10');
    CompanyTime.apply({'name': 'UTC', 'offset_min': 0});
    expect(dm(t), '20/10');
    expect(hm(t), '23:30');
  });

  test('India\'s half hour: hour ticks fall on his whole hours', () {
    CompanyTime.apply({'name': 'Asia/Kolkata', 'offset_min': 330});
    final t = DateTime.utc(2026, 10, 20, 10, 0); // 15:30 in India
    expect(hm(t), '15:30');
    expect(hourStart(t, 1), DateTime.utc(2026, 10, 20, 10, 30));
    expect(hm(hourStart(t, 1)), '16:00');
  });

  test('nothing from hq yet, or something malformed: the phone\'s zone', () {
    CompanyTime.apply(null);
    CompanyTime.apply({'name': 'Asia/Bangkok'});
    expect(CompanyTime.offset, isNull);
    final t = DateTime(2026, 10, 20, 9, 5);
    expect(hm(t), '09:05');
    expect(dayStart(t), DateTime(2026, 10, 20));
  });
}
