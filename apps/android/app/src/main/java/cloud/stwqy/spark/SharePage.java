package cloud.stwqy.spark;

import android.app.Activity;
import android.os.Build;
import android.text.InputFilter;
import android.text.InputType;
import android.text.TextUtils;
import android.view.Gravity;
import android.view.View;
import android.widget.Button;
import android.widget.CheckBox;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;

import java.util.ArrayList;
import java.util.List;

/** Shared layout and native controls for capture, drafts, and the WebView fallback. */
final class SharePage {
    final ScrollView root;
    final TextView status;
    private final LinearLayout column;
    private final Activity activity;
    private final List<View> busyControls = new ArrayList<>();

    SharePage(Activity activity, String title) {
        this.activity = activity;
        root = new ScrollView(activity);
        root.setFillViewport(true);
        root.setBackgroundResource(R.color.spark_surface);
        column = new LinearLayout(activity);
        column.setOrientation(LinearLayout.VERTICAL);
        column.setPadding(dp(20), dp(20), dp(20), dp(24));
        column.setFocusableInTouchMode(true);
        root.addView(column);
        TextView heading = label(title, 24);
        heading.setTypeface(android.graphics.Typeface.DEFAULT_BOLD);
        if (Build.VERSION.SDK_INT >= 28) heading.setAccessibilityHeading(true);
        status = label("", 15);
        status.setTextColor(activity.getColor(R.color.spark_muted));
        status.setAccessibilityLiveRegion(View.ACCESSIBILITY_LIVE_REGION_POLITE);
    }

    TextView label(String value, int size) {
        TextView label = new TextView(activity);
        label.setText(value);
        label.setTextSize(size);
        label.setPadding(0, dp(4), 0, dp(4));
        column.addView(label);
        return label;
    }

    void placeEditorStatus() {
        column.removeView(status);
        column.addView(status);
        status.setMinLines(2);
    }

    EditText field(String name, String value, boolean frozen, int lines) {
        TextView label = label(name, 15);
        EditText field = new EditText(activity);
        field.setId(View.generateViewId());
        label.setLabelFor(field.getId());
        field.setSaveEnabled(false);
        if (Build.VERSION.SDK_INT >= 26) {
            field.setImportantForAutofill(View.IMPORTANT_FOR_AUTOFILL_NO_EXCLUDE_DESCENDANTS);
        }
        field.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_FLAG_MULTI_LINE);
        field.setGravity(Gravity.TOP | Gravity.START);
        field.setTextSize(17);
        field.setMinLines(lines);
        field.setMaxLines(lines + 3);
        field.setText(value);
        if (frozen) {
            field.setKeyListener(null);
            field.setTextIsSelectable(true);
        } else {
            field.setFilters(new InputFilter[]{(source, start, end, dest, dstart, dend) -> {
                if ((long) dest.length() - (dend - dstart) + (end - start)
                        <= CollectionPayload.MAX_UTF16_UNITS) return null;
                status.setText("输入过长，请分段收藏。");
                return dest.subSequence(dstart, dend);
            }});
        }
        column.addView(field, new LinearLayout.LayoutParams(-1, -2));
        return field;
    }

    CheckBox aiExclusion(boolean checked, boolean frozen) {
        CheckBox box = new CheckBox(activity);
        box.setText("本条不参与 AI 整理");
        box.setTextSize(16);
        box.setMinHeight(dp(48));
        box.setChecked(checked);
        box.setEnabled(!frozen);
        column.addView(box, new LinearLayout.LayoutParams(-1, -2));
        return box;
    }

    Button button(String text, Runnable action) {
        return addButton(text, false, action);
    }

    Button primaryButton(String text, Runnable action) {
        return addButton(text, true, action);
    }

    void draftRow(String text, Runnable action) {
        Button row = button(text, action);
        row.setMaxLines(2);
        row.setEllipsize(TextUtils.TruncateAt.END);
        row.setGravity(Gravity.CENTER_VERTICAL | Gravity.START);
    }

    private Button addButton(String text, boolean primary, Runnable action) {
        Button button = new Button(activity, null,
                primary ? android.R.attr.buttonStyle : android.R.attr.borderlessButtonStyle);
        button.setText(text);
        button.setAllCaps(false);
        button.setTextSize(16);
        button.setMinHeight(dp(48));
        if (primary) {
            button.setBackgroundTintList(activity.getColorStateList(R.color.spark_primary_button));
            button.setTextColor(activity.getColor(R.color.spark_on_accent));
        }
        button.setOnClickListener(view -> action.run());
        column.addView(button, new LinearLayout.LayoutParams(-1, -2));
        return button;
    }

    void setBusy(boolean busy) {
        if (busy) {
            for (int i = 0; i < column.getChildCount(); i++) {
                View child = column.getChildAt(i);
                if (child.isEnabled() && (child instanceof Button || child instanceof EditText)) {
                    busyControls.add(child);
                    child.setEnabled(false);
                }
            }
        } else {
            for (View control : busyControls) control.setEnabled(true);
            busyControls.clear();
        }
    }

    private int dp(int units) {
        return Math.round(units * activity.getResources().getDisplayMetrics().density);
    }
}
