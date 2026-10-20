import 'package:agent_company/data/backend_select.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

const gw = 'https://app.hq.example.com/hq';

Future<String?> after(String? saved) async {
  SharedPreferences.setMockInitialValues({kHqUrl: ?saved, kHqToken: 'tok'});
  final p = await SharedPreferences.getInstance();
  await followGateway(p, gw);
  return p.getString(kHqUrl);
}

void main() {
  test('a session saved under the old secret path moves to the root hq, token kept', () async {
    expect(await after('https://app.hq.example.com/00000000000000000000000000000000/hq'), gw);
    expect((await SharedPreferences.getInstance()).getString(kHqToken), 'tok');
  });

  test('another host, the same address, or nothing saved stays as it is', () async {
    expect(await after('https://api.hq.example.com'), 'https://api.hq.example.com');
    expect(await after(gw), gw);
    expect(await after('https://app.hq.example.com/qa/hq'), 'https://app.hq.example.com/qa/hq');
    expect(await after(null), isNull);
  });
}
