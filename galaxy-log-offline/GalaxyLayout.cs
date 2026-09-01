namespace GalaxyLogOffline;

public static class GalaxyLayout
{
    private const int CardSpacing = 10;

    public static int Columns(int clientWidth, int horizontalPadding, int scrollbarWidth)
    {
        var available = Math.Max(0, clientWidth - Math.Max(0, horizontalPadding) - Math.Max(0, scrollbarWidth));
        return available >= 1080 ? 3 : available >= 720 ? 2 : 1;
    }

    public static int CardWidth(int clientWidth, int horizontalPadding, int scrollbarWidth)
    {
        var available = clientWidth - Math.Max(0, horizontalPadding) - Math.Max(0, scrollbarWidth);
        var columns = Columns(clientWidth, horizontalPadding, scrollbarWidth);
        return Math.Max(280, (available - (columns * CardSpacing)) / columns);
    }
}
