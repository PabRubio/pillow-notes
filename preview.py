"""Render the small LaTeX subset used by our notes as plain HTML."""

import html
import re


def latex_preview(source):
    title = re.search(r"\\title\{((?:[^{}]|\{[^{}]*\})*)\}", source)
    body = source.split(r"\begin{document}", 1)[-1].split(r"\end{document}", 1)[0]
    body = body.replace(r"\maketitle", r"\section*{" + (title.group(1) if title else "") + "}")
    saved = []

    def save(content, block=False):
        token = "\x00{}\x00".format(len(saved))
        saved.append((token, content, block))
        return token

    # Protect code and maths before converting prose and formatting commands.
    body = re.sub(
        r"\\begin\{(lstlisting|verbatim)\}(?:\[[^\]]*\])?\s*\n?(.*?)\\end\{\1\}",
        lambda m: save("<pre><code>" + html.escape(m.group(2).strip("\n")) + "</code></pre>", True),
        body, flags=re.S,
    )

    def maths(match):
        text = match.group()
        block = text.startswith(("$$", r"\[", r"\begin"))
        if text.startswith("$$"):
            text = r"\[" + text[2:-2] + r"\]"
        elif text.startswith("$"):
            text = r"\(" + text[1:-1] + r"\)"
        tag = "div" if block else "span"
        return save("<{}>{}</{}>".format(tag, html.escape(text), tag), block)

    body = re.sub(
        r"(?<!\\)\$\$.*?(?<!\\)\$\$|(?<!\\)\$(?!\$).*?(?<!\\)\$|"
        r"\\\[.*?\\\]|\\\(.*?\\\)|"
        r"\\begin\{(equation\*?|align\*?|gather\*?)\}.*?\\end\{\1\}",
        maths, body, flags=re.S,
    )
    body = re.sub(r"\\([{}$%&_#])", lambda m: save(html.escape(m.group(1))), body)
    body = re.sub(r"(?<!\\)%[^\n]*", "", body)
    body = html.escape(body)
    tags = {
        "section": "h2", "subsection": "h3", "subsubsection": "h4",
        "paragraph": "h4", "subparagraph": "h5", "textbf": "strong",
        "textit": "em", "emph": "em", "texttt": "code", "underline": "u",
        "textrm": "span", "textnormal": "span",
    }
    pattern = r"\\(" + "|".join(tags) + r")\*?\{([^{}]*)\}"
    while re.search(pattern, body):
        body = re.sub(pattern, lambda m: "<{0}>{1}</{0}>".format(tags[m.group(1)], m.group(2)), body)
    body = body.replace(r"\\", "<br>").replace("~", " ")
    body = re.sub(r"\\(?:noindent|smallskip|medskip|bigskip)\b", "", body)
    body = body.replace(r"\ldots", "…").replace(r"\LaTeX", "LaTeX")

    lists = []

    def list_tag(match):
        command, kind, label = match.groups()
        if command == "begin":
            lists.append(False)
            return "<ul>" if kind == "itemize" else "<ol>"
        if command == "end":
            close_item = lists.pop() if lists else False
            return ("</li>" if close_item else "") + ("</ul>" if kind == "itemize" else "</ol>")
        close_item = bool(lists and lists[-1])
        if lists:
            lists[-1] = True
        return ("</li>" if close_item else "") + "<li>" + ("<strong>" + label + "</strong> " if label else "")

    body = re.sub(r"\\(begin|end)\{(itemize|enumerate)\}|\\item\b(?:\[([^\]]*)\])?", list_tag, body)
    chunks = []
    for chunk in re.split(r"\n\s*\n", body):
        chunk = chunk.strip()
        if not chunk:
            continue
        block = re.search(r"</?(?:h[2-5]|ul|ol|li)\b", chunk)
        block = block or any(token in chunk and is_block for token, _, is_block in saved)
        chunks.append(chunk if block else "<p>" + chunk + "</p>")
    result = "\n".join(chunks)
    for token, content, _ in saved:
        result = result.replace(token, content)
    return result
