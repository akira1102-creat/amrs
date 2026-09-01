namespace GalaxyLogOffline;

public static class GalaxyLayout
{
    public static int CardWidth(int clientWidth, int horizontalPadding, int scrollbarWidth)
    {
        var available = clientWidth - Math.Max(0, horizontalPadding) - Math.Max(0, scrollbarWidth);
        return Math.Max(365, available);
    }
}
