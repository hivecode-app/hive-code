import 'backend.dart';

class SearchHit {
  const SearchHit({
    required this.kind,
    required this.id,
    required this.title,
    this.subtitle = '',
    this.identity,
    this.project,
    this.reportsTo,
    this.body = '',
    this.state,
  });
  final String kind, id, title, subtitle, body;
  final String? state;
  final String? identity, project, reportsTo;
  factory SearchHit.fromJson(Map<String, dynamic> j) => SearchHit(
    kind: j['kind'] as String,
    id: j['id'] as String,
    title: j['title'] as String,
    subtitle: j['subtitle'] as String? ?? '',
    identity: j['identity'] as String?,
    project: j['project'] as String?,
    reportsTo: j['reports_to'] as String?,
    body: j['body'] as String? ?? '',
    state: j['state'] as String?,
  );
}

List<SearchHit> searchLocal(CompanyData? d, String query) {
  if (d == null || query.trim().isEmpty) return [];
  final q = query.trim().toLowerCase();
  bool matches(String s) => s.toLowerCase().contains(q);
  return [
    for (final who in d.identities.values)
      if (d.canChat(who.id) && matches('${who.name} ${d.roleLine(who.id)}'))
        SearchHit(
          kind: 'person',
          id: who.id,
          identity: who.id,
          title: who.name,
          subtitle: d.roleLine(who.id),
          reportsTo: d.teamOf(who.id)?.leadId == who.id ? d.managerId : d.teamOf(who.id)?.leadId,
        ),
    for (final team in d.teams.values)
      if (matches(team.name)) SearchHit(kind: 'project', id: team.id, project: team.id, title: team.name),
    for (final t in d.openTasks)
      if (matches(t.title)) SearchHit(kind: 'task', id: '${t.id}', title: t.title, identity: t.worker ?? t.openedBy, project: t.project, state: t.state.name),
    for (final m in d.recent)
      if (matches(m.text)) SearchHit(kind: 'message', id: m.id, title: m.text, identity: m.id),
  ];
}
