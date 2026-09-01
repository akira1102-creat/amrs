using GalaxyLogOffline;

static class CsvContractTests
{
    private static void Assert(bool condition, string message)
    {
        if (!condition) throw new InvalidOperationException(message);
    }

    public static int Main()
    {
        var csv = "\ufeffSN,SN末4位,指定 Log 日期,取 Log 日期,狀態\r\nA02-001190,1190,2026/05/17,,未取\r\nA02-001193,1193,2026/06/02,2026-09-01,已取\r\nA02-001193,1193,2026/05/30,2026-09-01 已檢查無log,沒有當天 Log\r\n";
        var imported = CsvContract.Parse(csv, 200);
        Assert(imported.Tasks.Count == 3, "CSV row count");
        Assert(imported.Tasks[0].FullSerial == "A02-001190" && imported.Tasks[0].SerialLast4 == "1190", "full SN and last four");
        Assert(imported.Tasks[1].Status == "done" && imported.Tasks[1].CompletedDate == "2026-09-01", "done status");
        Assert(imported.Tasks[2].Status == "no_log" && imported.Tasks[2].CompletedDate == "2026-09-01", "no-log status");
        var output = CsvContract.Serialize(imported.Tasks);
        Assert(output.StartsWith("\ufeffSN,SN末4位,指定 Log 日期,取 Log 日期,狀態"), "UTF-8 BOM and headers");
        Assert(!output.Contains("備註", StringComparison.Ordinal), "no notes column");
        var local = new LocalSnapshot { Tasks = new() { imported.Tasks[0] }, ModifiedAtUtcTicks = 200 };
        var older = CsvContract.ReplaceIfNewer(local, imported);
        Assert(!older.Replaced && older.Reason == "same", "same snapshot must not replace");
        var olderImport = CsvContract.Parse(output, 100);
        var olderDecision = CsvContract.ReplaceIfNewer(local, olderImport);
        Assert(!olderDecision.Replaced && olderDecision.Reason == "older", "older snapshot must ask before replacing");
        var confirmedOlder = CsvContract.ReplaceIfNewer(local, olderImport, allowOlder: true);
        Assert(confirmedOlder.Replaced && confirmedOlder.Snapshot.Tasks.Count == 3, "confirmed older snapshot replaces all rows");
        var newer = CsvContract.Parse(output, 300);
        var decision = CsvContract.ReplaceIfNewer(local, newer);
        Assert(decision.Replaced && decision.Snapshot.Tasks.Count == 3, "newer snapshot replaces all rows");
        var filtered = GalaxyTaskFilter.Filter(imported.Tasks, "1193", "all");
        Assert(filtered.Count == 2 && filtered.All(task => task.SerialLast4 == "1193"), "search filter matches both Galaxy rows");
        Assert(GalaxyLayout.Columns(389, 10, 17) == 1, "narrow window uses one card column");
        Assert(GalaxyLayout.Columns(800, 10, 17) == 2, "wide window uses two card columns");
        Assert(GalaxyLayout.Columns(1200, 10, 17) == 3, "large window uses three card columns");
        Assert(GalaxyLayout.CardWidth(1200, 10, 17) == 381, "three-column card width");
        Console.WriteLine("CsvContractSmoke=PASS");
        return 0;
    }
}
