package cloud.stwqy.spark;

import android.content.ClipData;
import android.content.Intent;
import android.os.BadParcelableException;

/** Reads only explicit plain text from the system share sheet. */
final class SharedText {
    private SharedText() {}

    static String read(Intent launch) throws InvalidShare {
        if (!Intent.ACTION_SEND.equals(launch.getAction()) || !"text/plain".equalsIgnoreCase(launch.getType())) {
            throw new InvalidShare("此分享入口支持纯文字或网址。");
        }
        try {
            CharSequence text = launch.getCharSequenceExtra(Intent.EXTRA_TEXT);
            ClipData clip = launch.getClipData();
            if ((text == null || (text.length() <= CollectionPayload.MAX_UTF16_UNITS
                    && !CollectionPayload.hasNonWhitespace(text))) && clip != null && clip.getItemCount() == 1) {
                text = clip.getItemAt(0).getText();
            }
            if (text == null || text.length() > CollectionPayload.MAX_UTF16_UNITS
                    || !CollectionPayload.hasNonWhitespace(text)) {
                throw new InvalidShare("未收到可保存的文字，或分享内容过长。");
            }
            String original = text.toString(); // Drop sender-supplied spans.
            CharSequence subject = launch.getCharSequenceExtra(Intent.EXTRA_SUBJECT);
            return withLinkTitle(original, subject);
        } catch (BadParcelableException | ClassCastException invalid) {
            throw new InvalidShare("无法读取分享内容，请重新分享纯文字。");
        }
    }

    private static String withLinkTitle(String original, CharSequence subject) {
        if (subject == null || subject.length() > 200) return original;
        String title = subject.toString().trim();
        String link = original.trim();
        // A share with only a URL often carries its page title separately. Keep
        // already composed text unchanged and leave URL selection to CollectionPayload.
        if (!CollectionPayload.hasNonWhitespace(title) || title.indexOf('\n') >= 0 || title.indexOf('\r') >= 0
                || title.length() + 1L + original.length() > CollectionPayload.MAX_UTF16_UNITS
                || !link.equals(CollectionPayload.firstLink(link))
                || CollectionPayload.firstLink(title) != null) {
            return original;
        }
        return title + "\n" + original;
    }

    static final class InvalidShare extends Exception {
        InvalidShare(String message) { super(message); }
    }
}
