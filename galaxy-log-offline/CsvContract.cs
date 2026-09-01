using System.Globalization;
using System.Security.Cryptography;
using System.Text;

namespace GalaxyLogOffline;

public sealed class GalaxyTask
{
    public string Id { get; set; } = "";
    public string FullSerial { get; set; } = "";
    public string SerialLast4 { get; set; } = "";
    public string TargetDate { get; set; } = "";
    public string CompletedDate { get; set; } = "";
    public string Status { get; set; } = "pending";
}

public static class GalaxyTaskFilter
{
    public static IReadOnlyList<GalaxyTask> Filter(IEnumerable<GalaxyTask>? tasks, string? query, string? status)
    {
        var normalizedQuery = (query ?? "").Trim();
        var normalizedStatus = status ?? "pending";
        return (tasks ?? Enumerable.Empty<GalaxyTask>())
            .Where(task => (normalizedStatus == "all" || task.Status == normalizedStatus)
                && (normalizedQuery.Length == 0
                    || task.FullSerial.Contains(normalizedQuery, StringComparison.OrdinalIgnoreCase)
                    || task.SerialLast4.Contains(normalizedQuery, StringComparison.OrdinalIgnoreCase)))
            .ToList();
    }
}

public sealed class ImportedSnapshot
{
    public List<GalaxyTask> Tasks { get; init; } = new();
    public long ModifiedAtUtcTicks { get; init; }
}

public sealed class LocalSnapshot
{
    public List<GalaxyTask> Tasks { get; init; } = new();
    public long ModifiedAtUtcTicks { get; init; }
}

public sealed class SnapshotDecision
{
    public bool Replaced { get; init; }
    public string Reason { get; init; } = "";
    public LocalSnapshot Snapshot { get; init; } = new();
}

public static class CsvContract
{
    public static readonly string[] Headers = { "SN", "SN末4位", "指定 Log 日期", "取 Log 日期", "狀態" };

    public static ImportedSnapshot Parse(string content, long modifiedAtUtcTicks = 0)
    {
        var rows = ParseRows(content);
        if (rows.Count == 0) throw new InvalidDataException("CSV 沒有資料");
        var header = rows[0].Select(NormalizeHeader).ToList();
        var snIndex = FindHeader(header, "sn", "serial", "機身號碼", "機台號碼");
        var last4Index = FindHeader(header, "sn末4位", "末4位", "last4");
        var targetIndex = FindHeader(header, "指定log日期", "指定日期", "targetdate");
        var completedIndex = FindHeader(header, "取log日期", "完成日期", "completeddate");
        var statusIndex = FindHeader(header, "狀態", "status");
        if (targetIndex < 0 || completedIndex < 0) throw new InvalidDataException("找不到指定 Log 日期或取 Log 日期欄位");

        var tasks = new List<GalaxyTask>();
        var occurrence = new Dictionary<string, int>(StringComparer.OrdinalIgnoreCase);
        var currentSerial = "";
        for (var rowIndex = 1; rowIndex < rows.Count; rowIndex++)
        {
            var row = rows[rowIndex];
            var fullSerial = Cell(row, snIndex);
            if (!string.IsNullOrWhiteSpace(fullSerial)) currentSerial = NormalizeSerial(fullSerial);
            var last4 = Cell(row, last4Index);
            if (string.IsNullOrWhiteSpace(currentSerial)) currentSerial = NormalizeSerial(last4);
            if (string.IsNullOrWhiteSpace(currentSerial)) continue;
            var target = NormalizeDate(Cell(row, targetIndex));
            if (string.IsNullOrWhiteSpace(target)) continue;
            var completionRaw = Cell(row, completedIndex);
            var statusRaw = Cell(row, statusIndex);
            var noLog = IsNoLog(completionRaw) || IsNoLog(statusRaw);
            var completed = noLog ? ExtractNoLogDate(completionRaw) : NormalizeDate(completionRaw);
            var status = noLog ? "no_log" : !string.IsNullOrWhiteSpace(completed) || IsDone(statusRaw) ? "done" : IsReview(statusRaw) ? "needs_review" : "pending";
            var identity = $"{currentSerial}|{target}";
            occurrence.TryGetValue(identity, out var duplicateIndex);
            occurrence[identity] = duplicateIndex + 1;
            var serialLast4 = Last4(currentSerial);
            tasks.Add(new GalaxyTask
            {
                Id = BuildId(currentSerial, target, duplicateIndex),
                FullSerial = currentSerial,
                SerialLast4 = serialLast4,
                TargetDate = target,
                CompletedDate = completed,
                Status = status,
            });
        }
        if (tasks.Count == 0) throw new InvalidDataException("CSV 沒有可用的 Galaxy 清單");
        return new ImportedSnapshot { Tasks = tasks, ModifiedAtUtcTicks = modifiedAtUtcTicks };
    }

    public static string Serialize(IReadOnlyList<GalaxyTask> tasks)
    {
        var rows = new List<string[]> { Headers };
        foreach (var task in tasks ?? Array.Empty<GalaxyTask>())
        {
            rows.Add(new[]
            {
                task.FullSerial,
                task.SerialLast4.Length > 0 ? task.SerialLast4 : Last4(task.FullSerial),
                task.TargetDate,
                task.CompletedDate,
                Label(task.Status),
            });
        }
        return "\ufeff" + string.Join("\r\n", rows.Select(row => string.Join(",", row.Select(Escape)))) + "\r\n";
    }

    public static SnapshotDecision ReplaceIfNewer(LocalSnapshot local, ImportedSnapshot imported, bool allowOlder = false)
    {
        var existing = local ?? new LocalSnapshot();
        var incomingAt = imported?.ModifiedAtUtcTicks ?? 0;
        var existingAt = existing.ModifiedAtUtcTicks;
        var older = existingAt > 0 && incomingAt > 0 && incomingAt < existingAt;
        if (existingAt > 0 && incomingAt <= existingAt && !(allowOlder && older))
        {
            return new SnapshotDecision { Replaced = false, Reason = older ? "older" : "same", Snapshot = existing };
        }
        return new SnapshotDecision
        {
            Replaced = true,
            Reason = "newer",
            Snapshot = new LocalSnapshot
            {
                Tasks = (imported?.Tasks ?? new List<GalaxyTask>()).Select(Clone).ToList(),
                ModifiedAtUtcTicks = incomingAt > 0 ? incomingAt : DateTime.UtcNow.Ticks,
            },
        };
    }

    public static string NormalizeDate(string value)
    {
        var raw = (value ?? "").Trim();
        if (raw.Length == 0 || raw.Equals("n/a", StringComparison.OrdinalIgnoreCase) || raw == "-") return "";
        var formats = new[] { "yyyy-MM-dd", "yyyy/M/d", "yyyy/M/dd", "yyyy/MM/d", "yyyy/MM/dd", "d/M/yyyy", "dd/MM/yyyy", "d-M-yyyy", "dd-MM-yyyy" };
        return DateTime.TryParseExact(raw, formats, CultureInfo.InvariantCulture, DateTimeStyles.None, out var date)
            ? date.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture)
            : DateTime.TryParse(raw, CultureInfo.InvariantCulture, DateTimeStyles.AllowWhiteSpaces, out date)
                ? date.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture)
                : "";
    }

    private static List<string[]> ParseRows(string content)
    {
        var rows = new List<string[]>();
        var row = new List<string>();
        var cell = new StringBuilder();
        var quoted = false;
        var source = (content ?? "").TrimStart('\ufeff');
        for (var i = 0; i < source.Length; i++)
        {
            var ch = source[i];
            var next = i + 1 < source.Length ? source[i + 1] : '\0';
            if (ch == '"' && quoted && next == '"') { cell.Append('"'); i++; continue; }
            if (ch == '"') { quoted = !quoted; continue; }
            if (ch == ',' && !quoted) { row.Add(cell.ToString()); cell.Clear(); continue; }
            if ((ch == '\r' || ch == '\n') && !quoted)
            {
                if (ch == '\r' && next == '\n') i++;
                row.Add(cell.ToString()); cell.Clear();
                if (row.Any(value => !string.IsNullOrWhiteSpace(value))) rows.Add(row.ToArray());
                row.Clear(); continue;
            }
            cell.Append(ch);
        }
        if (cell.Length > 0 || row.Count > 0)
        {
            row.Add(cell.ToString());
            if (row.Any(value => !string.IsNullOrWhiteSpace(value))) rows.Add(row.ToArray());
        }
        return rows;
    }

    private static int FindHeader(IReadOnlyList<string> headers, params string[] names)
    {
        for (var i = 0; i < headers.Count; i++) if (names.Any(name => headers[i].Equals(NormalizeHeader(name), StringComparison.OrdinalIgnoreCase))) return i;
        return -1;
    }

    private static string NormalizeHeader(string value) => new string((value ?? "").Where(ch => !char.IsWhiteSpace(ch) && ch != '_' && ch != '-').ToArray()).ToLowerInvariant();
    private static string Cell(IReadOnlyList<string> row, int index) => index >= 0 && index < row.Count ? (row[index] ?? "").Trim() : "";
    private static string NormalizeSerial(string value) => new string((value ?? "").Trim().TrimStart('\'').Where(ch => !char.IsWhiteSpace(ch)).ToArray()).ToUpperInvariant();
    private static string Last4(string value) { var digits = new string((value ?? "").Where(char.IsDigit).ToArray()); return digits.Length >= 4 ? digits[^4..] : digits; }
    private static bool IsNoLog(string value) => (value ?? "").Contains("沒有當天", StringComparison.OrdinalIgnoreCase) || (value ?? "").Contains("已檢查無log", StringComparison.OrdinalIgnoreCase) || (value ?? "").Contains("no log", StringComparison.OrdinalIgnoreCase) || (value ?? "").Equals("no_log", StringComparison.OrdinalIgnoreCase);
    private static string ExtractNoLogDate(string value) => NormalizeDate((value ?? "").Replace("已檢查無log", "", StringComparison.OrdinalIgnoreCase).Replace("沒有當天 Log", "", StringComparison.OrdinalIgnoreCase).Replace("no log", "", StringComparison.OrdinalIgnoreCase));
    private static bool IsDone(string value) => (value ?? "").Contains("已取", StringComparison.OrdinalIgnoreCase) || (value ?? "").Contains("done", StringComparison.OrdinalIgnoreCase) || (value ?? "").Contains("完成", StringComparison.OrdinalIgnoreCase);
    private static bool IsReview(string value) => (value ?? "").Contains("需跟進", StringComparison.OrdinalIgnoreCase) || (value ?? "").Contains("review", StringComparison.OrdinalIgnoreCase);
    private static string Label(string status) => status switch { "done" => "已取", "no_log" => "沒有當天 Log", "needs_review" => "需跟進", _ => "未取" };
    private static string Escape(string value) { var raw = value ?? ""; return raw.IndexOfAny(new[] { ',', '"', '\r', '\n' }) >= 0 ? $"\"{raw.Replace("\"", "\"\"")}\"" : raw; }
    private static string BuildId(string serial, string date, int duplicate) { var bytes = SHA256.HashData(Encoding.UTF8.GetBytes($"{serial}|{date}|{duplicate}")); return "gx-" + Convert.ToHexString(bytes)[..12].ToLowerInvariant(); }
    private static GalaxyTask Clone(GalaxyTask task) => new() { Id = task.Id, FullSerial = task.FullSerial, SerialLast4 = task.SerialLast4, TargetDate = task.TargetDate, CompletedDate = task.CompletedDate, Status = task.Status };
}
