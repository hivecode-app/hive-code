// Placeholder until its PR lands.
import 'package:flutter/material.dart';

class TicketScreen extends StatelessWidget {
  const TicketScreen({super.key, required this.number, this.embedded = false});
  final bool embedded;
  final String number;
  
  @override
  Widget build(BuildContext context) => const SizedBox.shrink();
}
