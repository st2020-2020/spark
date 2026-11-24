package cloud.stwqy.spark.core.designsystem

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Shapes
import androidx.compose.material3.Typography
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

val LocalSparkColors = staticCompositionLocalOf { SparkTokens.colors(SparkPalette.MINT, dark = false) }
val LocalSparkStatusColors = staticCompositionLocalOf { SparkTokens.status(dark = false) }

private val sparkShapes = Shapes(
    extraSmall = RoundedCornerShape(6.dp),
    small = RoundedCornerShape(10.dp),
    medium = RoundedCornerShape(14.dp),
    large = RoundedCornerShape(18.dp),
    extraLarge = RoundedCornerShape(18.dp),
)

private val baseTypography = Typography()
private val sparkTypography = Typography(
    headlineSmall = baseTypography.headlineSmall.copy(fontSize = 26.sp),
    titleLarge = baseTypography.titleLarge.copy(fontSize = 22.sp),
    titleMedium = baseTypography.titleMedium.copy(fontSize = 18.sp),
    bodyLarge = baseTypography.bodyLarge.copy(fontSize = 16.sp, lineHeight = 28.sp),
    bodyMedium = baseTypography.bodyMedium.copy(fontSize = 14.sp),
    bodySmall = baseTypography.bodySmall.copy(fontSize = 13.sp),
    labelSmall = baseTypography.labelSmall.copy(fontSize = 12.sp),
)

@Composable
fun SparkTheme(
    palette: SparkPalette = SparkPalette.MINT,
    dark: Boolean = isSystemInDarkTheme(),
    content: @Composable () -> Unit,
) {
    val colors = SparkTokens.colors(palette, dark)
    val status = SparkTokens.status(dark)
    val base = if (dark) darkColorScheme() else lightColorScheme()
    val material = base.copy(
        primary = colors.primary,
        onPrimary = colors.onPrimary,
        primaryContainer = colors.accent,
        onPrimaryContainer = colors.accentFg,
        inversePrimary = SparkTokens.colors(palette, !dark).primary,
        secondary = colors.accentFg,
        onSecondary = colors.surface,
        secondaryContainer = colors.accent,
        onSecondaryContainer = colors.accentFg,
        tertiary = colors.spark,
        onTertiary = colors.onSpark,
        tertiaryContainer = colors.sparkSoft,
        onTertiaryContainer = colors.onSpark,
        background = colors.bg,
        onBackground = colors.fg,
        surface = colors.surface,
        onSurface = colors.fg,
        surfaceVariant = colors.surfaceMuted,
        onSurfaceVariant = colors.fgSoft,
        surfaceTint = colors.primary,
        inverseSurface = SparkTokens.colors(palette, !dark).surface,
        inverseOnSurface = SparkTokens.colors(palette, !dark).fg,
        error = status.danger,
        onError = colors.surface,
        errorContainer = status.dangerBg,
        onErrorContainer = status.danger,
        outline = colors.controlBorder,
        outlineVariant = colors.border,
        scrim = status.scrim,
        surfaceBright = colors.surface,
        surfaceDim = colors.surfaceMuted,
        surfaceContainerLowest = colors.surface,
        surfaceContainerLow = colors.bg,
        surfaceContainer = colors.surfaceMuted,
        surfaceContainerHigh = colors.surfaceMuted,
        surfaceContainerHighest = colors.surfaceMuted,
    )
    CompositionLocalProvider(LocalSparkColors provides colors, LocalSparkStatusColors provides status) {
        MaterialTheme(colorScheme = material, shapes = sparkShapes, typography = sparkTypography, content = content)
    }
}
