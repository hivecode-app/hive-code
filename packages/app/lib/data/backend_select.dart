// The one line that picks the backend. hq not live yet: the fake backend with the mockup's content.
// When hq is reachable, settings stores its URL + token and this returns HqBackend instead.
import 'backend.dart';
import 'fake_backend.dart';

Backend selectBackend() => FakeBackend();
