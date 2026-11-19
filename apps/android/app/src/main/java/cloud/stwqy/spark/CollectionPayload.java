package cloud.stwqy.spark;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.IOException;
import java.net.MalformedURLException;
import java.net.URI;
import java.net.URISyntaxException;
import java.nio.charset.StandardCharsets;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

final class CollectionPayload {
    private static final int MAX_CHARACTERS = 50000;
    private static final int MAX_DOCUMENT_NODES = 10000;
    private static final int MAX_REQUEST_BYTES = 1 << 20;
    private static final Pattern UUID = Pattern.compile(
            "[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}");
    private static final Pattern LINK = Pattern.compile(
            "https?://[^\\s\\p{Z}\\p{Cc}<>\"'“”‘’「」《》，。；！？（）]+", Pattern.CASE_INSENSITIVE);

    private CollectionPayload() {}

    static boolean isUuid(String value) {
        return value != null && UUID.matcher(value).matches();
    }

    static byte[] encode(String uuid, String text, String intent, boolean aiExcluded) throws IOException {
        if (!isUuid(uuid)) {
            throw new IOException("Invalid collection UUID");
        }
        if (intent == null) {
            intent = "";
        }
        // A supplementary character or a CRLF in shared text can occupy two UTF-16 units.
        if (text == null || (long) text.length() + intent.length() > 2 * MAX_CHARACTERS) {
            throw new IOException("Invalid collection text length");
        }
        text = text.replace("\r\n", "\n").replace('\r', '\n');
        if (text.codePointCount(0, text.length()) + intent.codePointCount(0, intent.length()) > MAX_CHARACTERS) {
            throw new IOException("Collection text and intent exceed 50000 characters");
        }
        if (!hasNonWhitespace(text)) {
            throw new IOException("Collection text is empty");
        }
        validateUnicode(text);
        validateUnicode(intent);

        try {
            JSONArray paragraphs = new JSONArray();
            int nodes = 1; // The doc root.
            for (String line : text.split("\n", -1)) {
                nodes += line.isEmpty() ? 1 : 2;
                if (nodes > MAX_DOCUMENT_NODES) {
                    throw new IOException("Collection has too many document nodes");
                }
                JSONObject paragraph = new JSONObject().put("type", "paragraph");
                if (!line.isEmpty()) {
                    JSONObject run = new JSONObject().put("type", "text").put("text", line);
                    paragraph.put("content", new JSONArray().put(run));
                }
                paragraphs.put(paragraph);
            }
            JSONObject document = new JSONObject()
                    .put("schema_version", 1)
                    .put("content", new JSONObject().put("type", "doc").put("content", paragraphs));
            JSONObject body = new JSONObject()
                    .put("id", uuid)
                    .put("document", document)
                    .put("intent", intent)
                    .put("upload_ids", new JSONArray())
                    .put("project_ids", new JSONArray())
                    .put("tag_ids", new JSONArray())
                    .put("ai_excluded", aiExcluded);
            String link = firstLink(text);
            if (link != null) {
                body.put("original_url", link);
            }
            byte[] bytes = body.toString().getBytes(StandardCharsets.UTF_8);
            if (bytes.length > MAX_REQUEST_BYTES) {
                throw new IOException("Collection request exceeds 1 MiB");
            }
            return bytes;
        } catch (JSONException invalid) {
            throw new IOException("Cannot encode collection");
        }
    }

    private static boolean hasNonWhitespace(String text) {
        for (int i = 0; i < text.length(); i++) {
            char c = text.charAt(i);
            if (!Character.isSpaceChar(c) && !(c >= '\t' && c <= '\r') && c != '\u0085') {
                return true;
            }
        }
        return false;
    }

    private static void validateUnicode(String value) throws IOException {
        for (int i = 0; i < value.length(); ) {
            int cp = value.codePointAt(i);
            // PostgreSQL rejects NUL and unpaired surrogates in stored JSON.
            if (cp == 0 || (cp >= Character.MIN_SURROGATE && cp <= Character.MAX_SURROGATE)) {
                throw new IOException("Unsupported character in collection");
            }
            i += Character.charCount(cp);
        }
    }

    private static String firstLink(String text) {
        Matcher links = LINK.matcher(text);
        while (links.find()) {
            String link = links.group();
            int parentheses = 0;
            int brackets = 0;
            for (int i = 0; i < link.length(); i++) {
                switch (link.charAt(i)) {
                    case '(': parentheses++; break;
                    case ')': parentheses--; break;
                    case '[': brackets++; break;
                    case ']': brackets--; break;
                    default: break;
                }
            }
            int end = link.length();
            while (end > 0 && ".,;!?)]}".indexOf(link.charAt(end - 1)) >= 0) {
                char last = link.charAt(end - 1);
                // Keep paired delimiters in paths and bracketed IPv6 hostnames.
                if ((last == ')' && parentheses >= 0) || (last == ']' && brackets >= 0)) {
                    break;
                }
                if (last == ')') parentheses++;
                if (last == ']') brackets++;
                end--;
            }
            link = link.substring(0, end);
            if (link.codePointCount(0, link.length()) > 4096) {
                continue;
            }
            try {
                URI uri = new URI(link);
                String authority = uri.getRawAuthority();
                if (authority != null && authority.indexOf('@') < 0 && authority.indexOf('%') < 0
                        && !uri.toURL().getHost().isEmpty()
                        && (uri.getHost() != null || authority.indexOf(':') < 0)) {
                    return link;
                }
            } catch (URISyntaxException | MalformedURLException ignored) {
                // The share remains intact even when this candidate is not a URL.
            }
        }
        return null;
    }
}
