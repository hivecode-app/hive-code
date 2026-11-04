import 'package:agent_company/data/auth_client.dart';
import 'package:agent_company/data/backend_select.dart';
import 'package:agent_company/data/fake_backend.dart';
import 'package:agent_company/data/store.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

class ScopedBackend extends FakeBackend {
  ScopedBackend(this.storageScope) : super(simulate: false);
  @override
  final String storageScope;
}
void main() {
  test('drafts and uploaded outbox entries stay with their company across a server switch', () async {
    SharedPreferences.setMockInitialValues({kHqUrl: 'https://old.example/hq', kHqToken: 'old', 'draft:adi': 'private draft', 'outbox': '[]'});
    await saveSession(const Session('https://new.example/hq', 'new'));
    final prefs = await SharedPreferences.getInstance();
    expect(prefs.getString('company:https://old.example/hq:draft:adi'), 'private draft');
    expect(prefs.getString('draft:adi'), isNull);
    expect(prefs.getString('outbox'), isNull);
    final a = AppStore(ScopedBackend('https://old.example/hq'));
    final b = AppStore(ScopedBackend('https://new.example/hq'));
    try {
      await a.start(); await b.start();
      final id = a.data!.chats.keys.first;
      a.setDraft(id, 'old company attachment discussion');
      b.setDraft(id, 'new company draft');
      expect(prefs.getString('company:https://old.example/hq:draft:$id'), 'old company attachment discussion');
      expect(prefs.getString('company:https://new.example/hq:draft:$id'), 'new company draft');
    } finally { a.dispose(); b.dispose(); a.backend.dispose(); b.backend.dispose(); }
  });
}
