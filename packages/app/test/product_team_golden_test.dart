// The team tab with every state on screen (noa on #454): the lead first, then who waits on him, who is blocked or
// stuck, who works, who is free and who rests; and who finished today folded at the end.
import 'package:agent_company/data/backend.dart';
import 'package:agent_company/data/fake_backend.dart';
import 'package:agent_company/data/hq_backend.dart';
import 'package:agent_company/ui/product/team.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'helpers.dart' show kDemoNow;
import 'product_test.dart' show productApp;

Map<String, dynamic> _id(String id, String name, String team, String kind, String lifecycle, String status, {String? project, String title = ''}) =>
    {'id': id, 'name': name, 'title': title, 'symbol': '', 'team': team, 'team_kind': kind, 'project': project, 'lifecycle': lifecycle, 'status': status, 'shift': null, 'reports_to': null, 'tone': null};

class _TeamBackend extends FakeBackend {
  _TeamBackend() : super(simulate: false, now: kDemoNow);
  late final CompanyData _snap = () {
    final today = DateTime(kDemoNow.year, kDemoNow.month, kDemoNow.day, 9).millisecondsSinceEpoch;
    return mapSnapshot(
      board: [
        _id('yoav', 'יואב', 'management', 'permanent', 'resident', 'free', title: 'מנהל החברה'),
        _id('adi', 'עדי', 'agent-company', 'project', 'lead', 'working', project: 'agent-company', title: 'מנכ"לית החברה'),
        _id('agent-company-t1', 'עומר', 'agent-company-t1', 'task', 'ephemeral', 'working', project: 'agent-company', title: 'מפתח'),
        _id('agent-company-t2', 'מאיה', 'agent-company-t2', 'task', 'ephemeral', 'waiting_for_you', project: 'agent-company', title: 'מפתחת'),
        _id('agent-company-t3', 'רון', 'agent-company-t3', 'task', 'ephemeral', 'blocked', project: 'agent-company', title: 'מפתח'),
        _id('agent-company-t4', 'שקד', 'agent-company-t4', 'task', 'ephemeral', 'done', project: 'agent-company', title: 'מפתחת'),
        _id('agent-company-t5', 'אלון', 'agent-company-t5', 'task', 'ephemeral', 'done', project: 'agent-company', title: 'מפתח'),
        _id('dana', 'דנה', 'lumo', 'project', 'lead', 'resting', project: 'lumo', title: 'מנכ"לית לומו'),
        _id('lumo-t1', 'טל', 'lumo-t1', 'task', 'ephemeral', 'stuck', project: 'lumo', title: 'מפתח'),
        _id('lumo-t2', 'עידו', 'lumo-t2', 'task', 'ephemeral', 'resting', project: 'lumo', title: 'מפתח'),
      ],
      inbox: const [],
      asks: const [],
      toggles: const [],
      tasks: [
        {'id': 1, 'title': 'מסך הצוות לפי הציור', 'state': 'running', 'identity': 'agent-company-t1', 'project': 'agent-company', 'updated_at': today},
        {'id': 2, 'title': 'p1: אישור לפריסה של שלב 1', 'state': 'running', 'identity': 'agent-company-t2', 'project': 'agent-company', 'updated_at': today},
        {'id': 3, 'title': 'ה-runner של ה-CI לא עונה', 'state': 'running', 'identity': 'agent-company-t3', 'project': 'agent-company', 'updated_at': today},
        {'id': 4, 'title': 'חיפוש במסך מלא בטלפון', 'state': 'done', 'identity': 'agent-company-t4', 'project': 'agent-company', 'updated_at': today},
        {'id': 5, 'title': 'עמודת המשימות בצ\'אט', 'state': 'done', 'identity': 'agent-company-t5', 'project': 'agent-company', 'updated_at': today},
        {'id': 6, 'title': 'build ל-TestFlight', 'state': 'running', 'identity': 'lumo-t1', 'project': 'lumo', 'updated_at': today},
        {'id': 7, 'title': 'מסך התשלום', 'state': 'resting', 'identity': 'lumo-t2', 'project': 'lumo', 'updated_at': today},
      ],
      projects: [
        {'id': 'agent-company', 'name': 'החברה', 'status': 'active', 'team': 'agent-company'},
        {'id': 'lumo', 'name': 'האפליקציה לומו', 'status': 'active', 'team': 'lumo'},
      ],
      now: kDemoNow,
    );
  }();
  @override
  CompanyData? get data => _snap;
}

void main() {
  Future<void> team(WidgetTester tester, String name, {String language = 'he', bool dark = false, double scale = 1, Size size = const Size(390, 844), bool open = false}) async {
    await productApp(tester, backend: _TeamBackend(), language: language, dark: dark, scale: scale, size: size, home: const Scaffold(body: ProductTeam()));
    // On the phone the fold stays closed, as he first sees it; the desktop goldens open it.
    if (open) {
      await tester.tap(find.byKey(const PageStorageKey('team-finished')));
      await tester.pumpAndSettle();
    }
    expect(tester.takeException(), isNull);
    await expectLater(find.byType(MaterialApp), matchesGoldenFile('golden/product/team-$name.png'));
  }

  for (final language in ['he', 'en']) {
    for (final dark in [false, true]) {
      testWidgets('team golden phone $language $dark', (tester) => team(tester, 'phone-$language-$dark', language: language, dark: dark));
    }
  }
  testWidgets('team golden phone he 200 percent', (tester) => team(tester, 'phone-he-2.0', scale: 2, size: const Size(390, 1400)));
  for (final width in [1280.0, 1440.0]) {
    testWidgets('team golden desktop $width', (tester) => team(tester, 'desktop-$width', size: Size(width, 1100), open: true));
  }
}
