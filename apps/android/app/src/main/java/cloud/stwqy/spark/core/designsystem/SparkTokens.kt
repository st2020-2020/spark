package cloud.stwqy.spark.core.designsystem

import androidx.compose.runtime.Immutable
import androidx.compose.ui.graphics.Color

enum class SparkPalette(val wireValue: String) {
    MINT("mint"), SEA("sea"), MATCHA("matcha"), SAKURA("sakura");

    companion object {
        fun fromWire(value: String?): SparkPalette = entries.firstOrNull { it.wireValue == value } ?: MINT
    }
}

@Immutable
data class PaperTone(val background: Color, val foreground: Color)

@Immutable
data class SparkStatusColors(
    val success: Color,
    val successBg: Color,
    val danger: Color,
    val dangerBg: Color,
    val warning: Color,
    val warningBg: Color,
    val scrim: Color,
    val shadowRgb: Color,
)

@Immutable
data class SparkColors(
    val bg: Color,
    val bgTranslucent: Color,
    val surface: Color,
    val surfaceMuted: Color,
    val surfaceHover: Color,
    val fg: Color,
    val fgSoft: Color,
    val muted: Color,
    val primary: Color,
    val primaryHover: Color,
    val onPrimary: Color,
    val accent: Color,
    val accentFg: Color,
    val spark: Color,
    val sparkStrong: Color,
    val onSpark: Color,
    val sparkSoft: Color,
    val border: Color,
    val borderStrong: Color,
    val controlBorder: Color,
    val focusRing: Color,
    val highlightBg: Color,
    val highlightFg: Color,
)

object SparkTokens {
    fun colors(palette: SparkPalette, dark: Boolean): SparkColors = when (palette) {
        SparkPalette.MINT -> if (dark) mintDark else mintLight
        SparkPalette.SEA -> if (dark) seaDark else seaLight
        SparkPalette.MATCHA -> if (dark) matchaDark else matchaLight
        SparkPalette.SAKURA -> if (dark) sakuraDark else sakuraLight
    }

    fun status(dark: Boolean): SparkStatusColors = if (dark) darkStatus else lightStatus

    fun projectTone(projectId: String, dark: Boolean): PaperTone =
        (if (dark) darkTape else lightTape)[projectToneIndex(projectId) - 1]

    // These values mirror apps/web/src/styles/tokens.css.
    private val mintLight = SparkColors(
        bg = rgb(0xf2f8f6),
        bgTranslucent = rgb(0xf2f8f6, 0.82f),
        surface = rgb(0xffffff),
        surfaceMuted = rgb(0xe7f1ed),
        surfaceHover = rgb(0x2c3e38, 0.05f),
        fg = rgb(0x2c3e38),
        fgSoft = rgb(0x4a5d56),
        muted = rgb(0x627870),
        primary = rgb(0x2a8369),
        primaryHover = rgb(0x23705a),
        onPrimary = rgb(0xffffff),
        accent = rgb(0xe0f2eb),
        accentFg = rgb(0x23705a),
        spark = rgb(0xffd9c7),
        sparkStrong = rgb(0xec9a78),
        onSpark = rgb(0x6b3420),
        sparkSoft = rgb(0xfff1ea),
        border = rgb(0xdcebe5),
        borderStrong = rgb(0xc3d8d0),
        controlBorder = rgb(0x7a948a),
        focusRing = rgb(0x2a8369, 0.22f),
        highlightBg = rgb(0xffe1d2),
        highlightFg = rgb(0x2c3e38),
    )

    private val mintDark = SparkColors(
        bg = rgb(0x0f1715),
        bgTranslucent = rgb(0x0f1715, 0.82f),
        surface = rgb(0x16201d),
        surfaceMuted = rgb(0x1f2b27),
        surfaceHover = rgb(0xe6f0ec, 0.06f),
        fg = rgb(0xe3eeea),
        fgSoft = rgb(0xc2d2cc),
        muted = rgb(0x93a8a0),
        primary = rgb(0x6fd1b2),
        primaryHover = rgb(0x8edcc3),
        onPrimary = rgb(0x0b2a21),
        accent = rgb(0x1c3a31),
        accentFg = rgb(0x8edcc3),
        spark = rgb(0xf2b49a),
        sparkStrong = rgb(0xf7c7b2),
        onSpark = rgb(0x3a1a0d),
        sparkSoft = rgb(0x3a2620),
        border = rgb(0x25332e),
        borderStrong = rgb(0x344640),
        controlBorder = rgb(0x62786f),
        focusRing = rgb(0x6fd1b2, 0.28f),
        highlightBg = rgb(0x5a3a2a),
        highlightFg = rgb(0xf6ede8),
    )

    private val seaLight = SparkColors(
        bg = rgb(0xf1f6fa),
        bgTranslucent = rgb(0xf1f6fa, 0.82f),
        surface = rgb(0xffffff),
        surfaceMuted = rgb(0xe6eef5),
        surfaceHover = rgb(0x2b3846, 0.05f),
        fg = rgb(0x2b3846),
        fgSoft = rgb(0x4a5868),
        muted = rgb(0x627283),
        primary = rgb(0x3274aa),
        primaryHover = rgb(0x2a6292),
        onPrimary = rgb(0xffffff),
        accent = rgb(0xe2eef8),
        accentFg = rgb(0x2a6292),
        spark = rgb(0xfff1a6),
        sparkStrong = rgb(0xe2bf3c),
        onSpark = rgb(0x5c4a00),
        sparkSoft = rgb(0xfff9db),
        border = rgb(0xdce7f0),
        borderStrong = rgb(0xc5d5e3),
        controlBorder = rgb(0x7e93a8),
        focusRing = rgb(0x3274aa, 0.22f),
        highlightBg = rgb(0xfff0a0),
        highlightFg = rgb(0x2b3846),
    )

    private val seaDark = SparkColors(
        bg = rgb(0x0f141a),
        bgTranslucent = rgb(0x0f141a, 0.82f),
        surface = rgb(0x161d25),
        surfaceMuted = rgb(0x1f2833),
        surfaceHover = rgb(0xe8eef5, 0.06f),
        fg = rgb(0xe3eaf2),
        fgSoft = rgb(0xc2cdd9),
        muted = rgb(0x93a2b3),
        primary = rgb(0x8cc0ec),
        primaryHover = rgb(0xa9d0f2),
        onPrimary = rgb(0x0b2238),
        accent = rgb(0x1c2e42),
        accentFg = rgb(0xa9d0f2),
        spark = rgb(0xf4e07a),
        sparkStrong = rgb(0xf8ea9e),
        onSpark = rgb(0x3a2f00),
        sparkSoft = rgb(0x363016),
        border = rgb(0x253140),
        borderStrong = rgb(0x34445a),
        controlBorder = rgb(0x647689),
        focusRing = rgb(0x8cc0ec, 0.28f),
        highlightBg = rgb(0x4f4618),
        highlightFg = rgb(0xf5f0d8),
    )

    private val matchaLight = SparkColors(
        bg = rgb(0xf6f7f1),
        bgTranslucent = rgb(0xf6f7f1, 0.82f),
        surface = rgb(0xfffffc),
        surfaceMuted = rgb(0xeceee4),
        surfaceHover = rgb(0x33392d, 0.05f),
        fg = rgb(0x33392d),
        fgSoft = rgb(0x4f5747),
        muted = rgb(0x6a7160),
        primary = rgb(0x557f45),
        primaryHover = rgb(0x476b39),
        onPrimary = rgb(0xffffff),
        accent = rgb(0xe9f0df),
        accentFg = rgb(0x476b39),
        spark = rgb(0xf3e3c3),
        sparkStrong = rgb(0xd4ac62),
        onSpark = rgb(0x5a4313),
        sparkSoft = rgb(0xfaf3e3),
        border = rgb(0xe3e7d9),
        borderStrong = rgb(0xcdd4c0),
        controlBorder = rgb(0x8a937c),
        focusRing = rgb(0x557f45, 0.22f),
        highlightBg = rgb(0xf6e2b0),
        highlightFg = rgb(0x33392d),
    )

    private val matchaDark = SparkColors(
        bg = rgb(0x12140f),
        bgTranslucent = rgb(0x12140f, 0.82f),
        surface = rgb(0x1a1d16),
        surfaceMuted = rgb(0x24281e),
        surfaceHover = rgb(0xecf0e4, 0.06f),
        fg = rgb(0xe8ecdf),
        fgSoft = rgb(0xc8cebc),
        muted = rgb(0x9ca38f),
        primary = rgb(0xa6cc8f),
        primaryHover = rgb(0xbcdba8),
        onPrimary = rgb(0x1c2e12),
        accent = rgb(0x27331e),
        accentFg = rgb(0xbcdba8),
        spark = rgb(0xe6cf9c),
        sparkStrong = rgb(0xeeddb6),
        onSpark = rgb(0x3a2c0c),
        sparkSoft = rgb(0x352d1a),
        border = rgb(0x2a2f23),
        borderStrong = rgb(0x3a4130),
        controlBorder = rgb(0x6e7660),
        focusRing = rgb(0xa6cc8f, 0.28f),
        highlightBg = rgb(0x4f4420),
        highlightFg = rgb(0xf2eedd),
    )

    private val sakuraLight = SparkColors(
        bg = rgb(0xfbf6f6),
        bgTranslucent = rgb(0xfbf6f6, 0.82f),
        surface = rgb(0xffffff),
        surfaceMuted = rgb(0xf5ebec),
        surfaceHover = rgb(0x3d2f32, 0.05f),
        fg = rgb(0x3d2f32),
        fgSoft = rgb(0x5c4a4e),
        muted = rgb(0x7f6a6e),
        primary = rgb(0xae5468),
        primaryHover = rgb(0x964457),
        onPrimary = rgb(0xffffff),
        accent = rgb(0xfbe6ea),
        accentFg = rgb(0x964457),
        spark = rgb(0xcfe6de),
        sparkStrong = rgb(0x6fb29b),
        onSpark = rgb(0x24574a),
        sparkSoft = rgb(0xeaf5f1),
        border = rgb(0xf0e1e3),
        borderStrong = rgb(0xe2cbcf),
        controlBorder = rgb(0xa28c90),
        focusRing = rgb(0xae5468, 0.22f),
        highlightBg = rgb(0xfcd9e0),
        highlightFg = rgb(0x3d2f32),
    )

    private val sakuraDark = SparkColors(
        bg = rgb(0x171213),
        bgTranslucent = rgb(0x171213, 0.82f),
        surface = rgb(0x201a1b),
        surfaceMuted = rgb(0x2b2325),
        surfaceHover = rgb(0xf5e8ea, 0.06f),
        fg = rgb(0xf2e6e8),
        fgSoft = rgb(0xd6c4c7),
        muted = rgb(0xaa959a),
        primary = rgb(0xf0a3b4),
        primaryHover = rgb(0xf5bac7),
        onPrimary = rgb(0x3d1520),
        accent = rgb(0x3a2329),
        accentFg = rgb(0xf5bac7),
        spark = rgb(0x9fd3c1),
        sparkStrong = rgb(0xb9e0d2),
        onSpark = rgb(0x0f2e25),
        sparkSoft = rgb(0x1d302a),
        border = rgb(0x33282a),
        borderStrong = rgb(0x463639),
        controlBorder = rgb(0x7f6b6f),
        focusRing = rgb(0xf0a3b4, 0.28f),
        highlightBg = rgb(0x5a2e38),
        highlightFg = rgb(0xf8e8eb),
    )

    private val lightStatus = SparkStatusColors(
        success = rgb(0x2f7d55),
        successBg = rgb(0xe6f4ec),
        danger = rgb(0xc2334d),
        dangerBg = rgb(0xfdeff1),
        warning = rgb(0x8a5a00),
        warningBg = rgb(0xfff5dc),
        scrim = rgb(0x1e2628, 0.36f),
        shadowRgb = rgb(0x283438),
    )

    private val lightTape = listOf(
        PaperTone(rgb(0xffd9c7), rgb(0x7a3a22)),
        PaperTone(rgb(0xcdebdd), rgb(0x1f5e48)),
        PaperTone(rgb(0xd3e6f7), rgb(0x24527d)),
        PaperTone(rgb(0xffefb0), rgb(0x6b5300)),
        PaperTone(rgb(0xe3dcf5), rgb(0x4b3c80)),
        PaperTone(rgb(0xf8d7df), rgb(0x8a3a4e)),
    )

    private val darkStatus = SparkStatusColors(
        success = rgb(0x7fd6a6),
        successBg = rgb(0x173126),
        danger = rgb(0xff9aaa),
        dangerBg = rgb(0x3a1c24),
        warning = rgb(0xf2c66e),
        warningBg = rgb(0x33280f),
        scrim = rgb(0x000000, 0.55f),
        shadowRgb = rgb(0x000000),
    )

    private val darkTape = listOf(
        PaperTone(rgb(0x4a3027), rgb(0xf7cdb9)),
        PaperTone(rgb(0x1f3d33), rgb(0xbfe8d6)),
        PaperTone(rgb(0x213448), rgb(0xc5ddf3)),
        PaperTone(rgb(0x463c17), rgb(0xf3e3a0)),
        PaperTone(rgb(0x322b4a), rgb(0xd6ccf2)),
        PaperTone(rgb(0x45272f), rgb(0xf5c9d4)),
    )

    private fun rgb(value: Long, alpha: Float = 1f): Color =
        Color(0xff000000L or value).copy(alpha = alpha)
}
