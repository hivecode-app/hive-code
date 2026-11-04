import 'dart:convert';
import 'package:http/http.dart' as http;
import 'auth_client.dart';

/// Device-authenticated setup and work preferences. No offline mutation queue.
class ProductClient {
  ProductClient(this.session, {http.Client? httpClient}) : _http = httpClient ?? http.Client();
  final Session session;
  final http.Client _http;
  void close() => _http.close();
  Future<Map<String, dynamic>> request(String path, [Map<String, dynamic>? body]) async {
    final uri = Uri.parse('${session.baseUrl}$path');
    final headers = {'authorization': 'Bearer ${session.token}', 'content-type': 'application/json'};
    final response = await (body == null ? _http.get(uri, headers: headers) : _http.post(uri, headers: headers, body: jsonEncode(body)))
        .timeout(const Duration(seconds: 25));
    if (response.statusCode != 200) throw ProductFailure(response.statusCode);
    return (jsonDecode(utf8.decode(response.bodyBytes)) as Map).cast<String, dynamic>();
  }
}
class ProductFailure implements Exception {
  const ProductFailure(this.status);
  final int status;
}
