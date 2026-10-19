// Placeholder until its PR lands.
import 'package:flutter/material.dart';

class ChatScreen extends StatelessWidget {
  const ChatScreen({super.key, required this.identityId});
  final String identityId;
  static final Map<String, dynamic> pendingQuote = {};
  @override
  Widget build(BuildContext context) => const SizedBox.shrink();
}
