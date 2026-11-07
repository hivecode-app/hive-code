import 'package:agent_company/l10n/input_copy.dart';
import 'package:agent_company/l10n/ui_copy.dart';
// The "משאבים" screen's data: what each machine holds by project and who waits for room, as hq's `GET /api/resources` sends
// it (packages/hq/src/resources.ts, leases.ts). Memory is in MB there; the words ("עמוס", "מתמלא") are decided here.

num? _num(Object? v) => v is num ? v : null;
String? _str(Object? v) => v is String && v.isNotEmpty ? v : null;

/// How full one thing on a machine is: a level for its word, and whether it stands in front of a threshold (the warning icon).
class Reading {
  const Reading(this.word, {this.warn = false});
  final String word;
  final bool warn;
}

/// The parts of a machine's reading hq could not take, in his words (`unmeasured`).
Map<String, String> get kPartWords => {
  'memory': UiCopy.copy.memory,
  'disk': UiCopy.copy.disk,
  'cgroups': UiCopy.copy.detailsProject,
  'docker': 'docker',
  'docker-df': UiCopy.copy.dockerStorage,
};

class Holder {
  const Holder({required this.project, required this.name, required this.memMb, this.cpuPct, this.count = 1});

  /// null = לא מזוהה
  final String? project;
  final String name;
  final double memMb;
  final double? cpuPct;
  final int count;

  static Holder? fromJson(Object? j) {
    if (j is! Map) return null;
    final mem = _num(j['mem_mb']);
    if (mem == null) return null;
    final project = _str(j['project']);
    return Holder(project: project, name: _str(j['name']) ?? (project ?? UiCopy.copy.unknown), memMb: mem.toDouble(), cpuPct: _num(j['cpu_pct'])?.toDouble(), count: _num(j['count'])?.toInt() ?? 1);
  }
}

class Unidentified {
  const Unidentified({required this.name, required this.memMb});

  /// As hq reads it: a cgroup path or a container name.
  final String name;
  final double memMb;

  /// A name he can read: the unit's last part, with what it is when that is known. The full name stays under it.
  String get readable {
    var last = name.split('/').last.replaceAll(RegExp(r'\.(service|scope|slice)$'), '');
    last = last.replaceAll(RegExp(r'\s*\(.*\)$'), '');
    if (RegExp(r'^docker-[0-9a-f]{12,}$').hasMatch(last)) return UiCopy.copy.dockerContainer;
    if (last.toLowerCase().contains('gradle')) return UiCopy.copy.gradleBuild;
    if (last.toLowerCase().contains('kotlin')) return UiCopy.copy.kotlinBuild;
    return last.isEmpty ? name : last;
  }

  static Unidentified? fromJson(Object? j) {
    if (j is! Map) return null;
    final name = _str(j['name']), mem = _num(j['mem_mb']);
    return name == null || mem == null ? null : Unidentified(name: name, memMb: mem.toDouble());
  }
}

class MachineRes {
  const MachineRes({
    required this.name,
    required this.label,
    required this.measured,
    this.error,
    this.unmeasured = const [],
    this.memTotalMb,
    this.memUsedMb,
    this.load1,
    this.cpus,
    this.diskPct,
    this.diskFreeMb,
    this.holders = const [],
    this.unidentified = const [],
  });

  final String name, label;

  /// false: no fresh reading, so nothing below is a measurement of now.
  final bool measured;
  final String? error;
  final List<String> unmeasured;
  final double? memTotalMb, memUsedMb, load1, diskFreeMb;
  final int? cpus, diskPct;
  final List<Holder> holders;
  final List<Unidentified> unidentified;

  static MachineRes? fromJson(Object? j) {
    if (j is! Map) return null;
    final name = _str(j['name']);
    if (name == null) return null;
    final mem = j['mem'] is Map ? j['mem'] as Map : null;
    final disk = j['disk'] is Map ? j['disk'] as Map : null;
    return MachineRes(
      name: name,
      label: _str(j['label']) ?? name,
      measured: j['measured'] == true,
      error: _str(j['error']),
      unmeasured: [for (final p in (j['unmeasured'] as List?) ?? const []) if (p is String) p],
      memTotalMb: _num(mem?['total_mb'])?.toDouble(),
      memUsedMb: _num(mem?['used_mb'])?.toDouble(),
      load1: _num(j['load1'])?.toDouble(),
      cpus: _num(j['cpus'])?.toInt(),
      diskPct: _num(disk?['pct'])?.toInt(),
      diskFreeMb: _num(disk?['free_mb'])?.toDouble(),
      holders: [for (final h in (j['holders'] as List?) ?? const []) ?Holder.fromJson(h)],
      unidentified: [for (final u in (j['unidentified'] as List?) ?? const []) ?Unidentified.fromJson(u)],
    );
  }

  /// Memory: under 75% used is fine, up to 90% busy, over it nearly full (hq holds back new shifts well before the end).
  Reading? get memory {
    final used = memUsedMb, total = memTotalMb;
    if (used == null || total == null || total <= 0) return null;
    final f = used / total;
    return f >= 0.9 ?  Reading(UiCopy.copy.almostFull, warn: true) : f >= 0.75 ?  Reading(UiCopy.copy.busy) :  Reading(UiCopy.copy.normal);
  }

  /// CPU: the load of the last minute per core. Under half a core each is quiet; over one, work waits for a core.
  Reading? get cpu {
    final l = load1, c = cpus;
    if (l == null || c == null || c <= 0) return null;
    final f = l / c;
    return f >= 1 ?  Reading(UiCopy.copy.veryBusy, warn: true) : f >= 0.5 ?  Reading(UiCopy.copy.busy) :  Reading(UiCopy.copy.quiet);
  }

  /// Disk: hq cleans at 85% and writes to him at 92%.
  Reading? get disk {
    final p = diskPct;
    if (p == null) return null;
    return p >= 92 ?  Reading(UiCopy.copy.almostFull, warn: true) : p >= 85 ?  Reading(UiCopy.copy.fillingUp, warn: true) :  Reading(UiCopy.copy.normal);
  }

  /// Why there is no reading, in a sentence: hq's own Hebrew when it has one, else that the machine did not answer.
  String get errorWords => error != null && RegExp(InputCopy.v31).hasMatch(error!) ? error! : UiCopy.copy.serverDidNotRespond;

  /// The parts hq could not read, as words: they are said, never left out.
  List<String> get unmeasuredWords => [for (final p in unmeasured) if (p != 'memory' && p != 'disk') kPartWords[p] ?? p];

  /// The row "לא מזוהה" is always shown; this is what it holds (0 when nothing).
  double get unidentifiedMb => holders.where((h) => h.project == null).fold(0.0, (n, h) => n + h.memMb);
}

class WaitingRes {
  const WaitingRes({required this.task, required this.title, required this.waitingMin, this.ref, this.waitingFor, this.etaMin});
  final int task;
  final String? ref;
  final String title;
  final int waitingMin;

  /// Who holds the machine, as hq says it ("לומו מחזיק 6.1GB").
  final String? waitingFor;

  /// In how many minutes it is expected to start; null = hq has no honest estimate.
  final int? etaMin;

  static WaitingRes? fromJson(Object? j) {
    if (j is! Map) return null;
    final task = _num(j['task']), title = _str(j['title']);
    if (task == null || title == null) return null;
    return WaitingRes(task: task.toInt(), ref: _str(j['ref']), title: title, waitingMin: _num(j['waiting_min'])?.toInt() ?? 0, waitingFor: _str(j['waiting_for']), etaMin: _num(j['eta_min'])?.toInt());
  }
}

class LeaseRes {
  const LeaseRes({required this.id, required this.machine, required this.cls, required this.granted, required this.memMb, required this.ageMin, this.task, this.project, this.note, this.etaMin, this.waitingFor});
  final String id, machine, cls;
  final bool granted;
  final double memMb;

  /// granted: since it was given · queued: since it asked
  final int ageMin;
  final int? task, etaMin;
  final String? project, note, waitingFor;

  static LeaseRes? fromJson(Object? j) {
    if (j is! Map) return null;
    final id = _str(j['id']), machine = _str(j['machine']), cls = _str(j['class']);
    if (id == null || machine == null || cls == null) return null;
    return LeaseRes(
      id: id,
      machine: machine,
      cls: cls,
      granted: j['state'] == 'granted',
      memMb: _num(j['mem_mb'])?.toDouble() ?? 0,
      ageMin: _num(j['age_min'])?.toInt() ?? 0,
      task: _num(j['task'])?.toInt(),
      project: _str(j['project_name']) ?? _str(j['project']),
      note: _str(j['note']),
      etaMin: _num(j['eta_min'])?.toInt(),
      waitingFor: _str(j['waiting_for']),
    );
  }
}

class ResourcesView {
  const ResourcesView({required this.machines, required this.waiting, required this.leases});
  final List<MachineRes> machines;
  final List<WaitingRes> waiting;
  final List<LeaseRes> leases;

  static ResourcesView fromJson(Map<String, dynamic> j) => ResourcesView(
        machines: [for (final m in (j['machines'] as List?) ?? const []) ?MachineRes.fromJson(m)],
        waiting: [for (final w in (j['waiting'] as List?) ?? const []) ?WaitingRes.fromJson(w)],
        leases: [for (final l in (j['leases'] as List?) ?? const []) ?LeaseRes.fromJson(l)],
      );
}
