// B.7 switch button: HqBackend reads /api/accounts and pins with PUT /api/accounts/pinned.
import 'dart:convert';

import 'package:agent_company/data/hq_backend.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

void main() {
  test('accounts view and "כולם ל-X"', () async {
    final sent = <http.Request>[];
    final hq = HqBackend(
      baseUrl: 'http://hq',
      token: 't',
      client: MockClient((req) async {
        sent.add(req);
        if (req.method == 'GET') {
          return http.Response(
              jsonEncode({
                'pinned': null,
                'active': 'owner-account',
                'accounts': [
                  {'name': 'owner-account', 'label': 'החשבון הראשי', 'usable': true, 'blocked_until': null, 'room': 26},
                  {'name': 'hive-owner', 'label': 'hive-owner', 'usable': false, 'blocked_until': null, 'room': 100, 'note': 'מחכה להתחברות'},
                ],
              }),
              200,
              headers: {'content-type': 'application/json; charset=utf-8'});
        }
        return http.Response('{}', 200);
      }),
    );
    final v = (await hq.accounts())!;
    expect(v.active, 'owner-account');
    expect(v.accounts.map((a) => a.label), ['החשבון הראשי', 'hive-owner']);
    expect(v.accounts[1].usable, false);
    expect(v.accounts[1].note, 'מחכה להתחברות');
    expect((await hq.pinAccount('hive-owner')).ok, true);
    expect(sent.last.method, 'PUT');
    expect(sent.last.url.path, '/api/accounts/pinned');
    expect(jsonDecode(sent.last.body), {'name': 'hive-owner'});
  });
}
