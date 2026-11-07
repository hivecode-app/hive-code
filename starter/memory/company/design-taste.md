---
name: design-taste
description: The company's design book. Base rules for every interface, document and message the company puts out, and an "AI slop" list that must not be sent. Applies to every worker, in every project. The owner's preferences go in here when the owner states them.
type: feedback
scope: company
---

# The design book

Base rules. They are nobody's preference, but what a mature product does. When the owner says something about design, it goes into the section "The owner's preferences" with a quote and a date, and wins over what is written here.

When a rule here contradicts a specific project's specification (a design document, Figma, an existing design system), the project wins.

## 1. The ten rules

1. **Copy a mature product, do not invent.** Find the well-known app that does the same thing, and copy the pattern from it: behaviour, motion, loading. The logo is the exception: original.
2. **Standard and quiet beats "designed".** A neutral palette, a light background, near-black text, thin lines, and the brand colour only on the primary action and on links.
3. **No placeholder that pretends to be something.** A temporary logo, a framework's default icon, a square with a letter: better to have nothing.
4. **An emoji is not an icon.** Not in a button, not in a menu, not in a heading, not as a state symbol.
5. **One icon set per product.** One mature library, one stroke weight. No hand-drawn SVG and no mixing sets. In the company's interfaces: Material Symbols.
6. **Every wait gets feedback.** A spinner, progress, or a screen that comes up before the data. Never a frozen screen or a button that does not respond.
7. **Mature motion or no motion.** No jumps while loading, no flicker, no animation for the sake of animation.
8. **Plain, short wording, no jargon and no codes.** An error is one sentence: what happened and what to do. The technical detail goes to the log.
9. **Text does not sound like AI** (section 3).
10. **A design change stays in the scope that was asked.** Swapping icons, font or colours does not go in "on the way". Check on the real device before shipping.

## 2. "AI slop": what must not be sent

Go through the list before sending the owner a screenshot, a version or a page. If one item appears, fix it before sending.

- [ ] A purple-blue gradient, a "glowing" background, glassmorphism, blur behind cards.
- [ ] A "dramatic" dark background that was not asked for.
- [ ] A generic hero: a huge heading with a gradient word, a vague subtitle, two buttons and a floating mockup.
- [ ] A grid of three cards, each with an icon in a coloured circle, a heading and a line.
- [ ] A list of benefits with a check mark next to each line ("✓ fast ✓ secure").
- [ ] Over-rounded cards with a soft, heavy shadow on everything.
- [ ] Emoji as bullets, in headings or in the role of an icon.
- [ ] A temporary logo or icon, or the framework's default icon.
- [ ] Filler micro-copy: "a seamless experience", "a smart, advanced solution", "welcome to…".
- [ ] A "New!" or "AI" badge on things that are not new.
- [ ] An entrance animation for every element on scroll.
- [ ] An error message with a code, `exception`, an HTTP status or an internal name.
- [ ] An action without feedback: a button that does not show it is working.
- [ ] Made-up numbers or customer testimonials that do not exist.

## 3. Wording

- Short, clear, in the user's language.
- No signs of model-generated text: em dash, "X, not Y", double negatives, a rhetorical question followed by its answer, corporate phrasing.
- The goal: as if a professional copywriter wrote it.
- When the owner edits a text personally, the owner's version wins. Do not rewrite after the owner.

## 4. Typography and colour

- **In an app:** the device's font, unless there is a reason.
- **On a website:** one font family per site.
- **Spacing:** not cramped. Text is not cut off and does not break the layout.
- **Colour:** neutral, and one brand colour. Red only for a destructive action and for an error. Contrast of at least 4.5:1 for text.
- **When a colour or font has to be chosen:** show 2–3 options on the real screen, and leave the choice to the owner.

## 5. The company's own interfaces

- State is shown with a word and an icon, not a colour and not an emoji.
- Every identity has a `symbol` (an icon name from Material Symbols) and a `monogram` of two letters. There is no colour field.

## 6. The owner's preferences

None yet. Every preference goes in here with a quote and a date, for example:

```
- **<topic>:** <the rule>. «<the owner's words>» (DD/MM/YYYY)
```
