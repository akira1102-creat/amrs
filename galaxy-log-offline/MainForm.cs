using System.Text;
using System.Text.Json;

namespace GalaxyLogOffline;

public partial class MainForm : Form
{
    private sealed class PersistedState
    {
        public List<GalaxyTask> Tasks { get; set; } = new();
        public long ModifiedAtUtcTicks { get; set; }
    }

    private readonly string statePath = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "AMRS", "GalaxyLogOffline", "state.json");
    private List<GalaxyTask> tasks = new();
    private long modifiedAtUtcTicks;
    private readonly System.Windows.Forms.Timer searchDebounceTimer;
    private readonly Dictionary<string, Panel> cardsById = new(StringComparer.Ordinal);
    private readonly Dictionary<string, CardParts> cardPartsById = new(StringComparer.Ordinal);
    private Label? emptyStateLabel;

    private sealed class CardParts
    {
        public Label Serial { get; init; } = null!;
        public Label Full { get; init; } = null!;
        public Label Target { get; init; } = null!;
        public Label State { get; init; } = null!;
        public Button Action { get; init; } = null!;
        public Button NoLog { get; init; } = null!;
    }

    public MainForm()
    {
        InitializeComponent();
        ApplyTheme();
        LoadState();
        searchDebounceTimer = new System.Windows.Forms.Timer { Interval = 120 };
        searchDebounceTimer.Tick += (_, _) => { searchDebounceTimer.Stop(); RenderTasks(); };
        importButton.Click += (_, _) => ImportCsv();
        exportButton.Click += (_, _) => ExportCsv();
        searchBox.TextChanged += (_, _) => { searchDebounceTimer.Stop(); searchDebounceTimer.Start(); };
        statusFilter.SelectedIndexChanged += (_, _) => RenderTasks();
        taskList.Resize += (_, _) => ResizeCards();
        FormClosed += (_, _) => searchDebounceTimer.Dispose();
        RenderTasks();
    }

    private void ApplyTheme()
    {
        foreach (var button in new[] { importButton, exportButton })
        {
            button.FlatStyle = FlatStyle.Flat; button.FlatAppearance.BorderSize = 1; button.Font = new Font("Segoe UI", 11F, FontStyle.Bold); button.ForeColor = Color.White; button.Cursor = Cursors.Hand;
        }
        importButton.BackColor = Color.FromArgb(35, 114, 229); importButton.FlatAppearance.BorderColor = Color.FromArgb(56, 139, 253);
        exportButton.BackColor = Color.FromArgb(33, 38, 45); exportButton.FlatAppearance.BorderColor = Color.FromArgb(72, 79, 88);
        searchBox.BackColor = Color.FromArgb(22, 27, 34); searchBox.ForeColor = Color.FromArgb(230, 237, 243); searchBox.BorderStyle = BorderStyle.FixedSingle;
        statusFilter.BackColor = Color.FromArgb(22, 27, 34); statusFilter.ForeColor = Color.FromArgb(230, 237, 243); statusFilter.FlatStyle = FlatStyle.Flat;
    }

    private void ImportCsv()
    {
        using var dialog = new OpenFileDialog { Filter = "CSV 檔案 (*.csv)|*.csv|所有檔案 (*.*)|*.*", Title = "匯入 Galaxy CSV" };
        if (dialog.ShowDialog(this) != DialogResult.OK) return;
        try
        {
            var imported = CsvContract.Parse(File.ReadAllText(dialog.FileName, new UTF8Encoding(false)), File.GetLastWriteTimeUtc(dialog.FileName).Ticks);
            var decision = CsvContract.ReplaceIfNewer(new LocalSnapshot { Tasks = tasks, ModifiedAtUtcTicks = modifiedAtUtcTicks }, imported);
            if (!decision.Replaced)
            {
                SetStatus("這份 CSV 比本機資料舊或相同，已保留本機資料", Color.FromArgb(210, 153, 34));
                return;
            }
            tasks = decision.Snapshot.Tasks; modifiedAtUtcTicks = decision.Snapshot.ModifiedAtUtcTicks; SaveState();
            SetStatus($"✓ 已匯入 {tasks.Count} 筆 CSV", Color.FromArgb(63, 185, 80)); RenderTasks();
        }
        catch (Exception ex) { SetStatus($"匯入失敗：{ex.Message}", Color.FromArgb(248, 81, 73)); }
    }

    private void ExportCsv()
    {
        if (tasks.Count == 0) { SetStatus("目前沒有可匯出的資料", Color.FromArgb(210, 153, 34)); return; }
        using var dialog = new SaveFileDialog { Filter = "CSV 檔案 (*.csv)|*.csv", FileName = $"Galaxy-Log-Offline-{DateTime.Now:yyyyMMdd}.csv", Title = "匯出 Galaxy CSV" };
        if (dialog.ShowDialog(this) != DialogResult.OK) return;
        try { File.WriteAllText(dialog.FileName, CsvContract.Serialize(tasks), new UTF8Encoding(true)); SetStatus("✓ CSV 已匯出，可帶回 AMRS 匯入", Color.FromArgb(63, 185, 80)); }
        catch (Exception ex) { SetStatus($"匯出失敗：{ex.Message}", Color.FromArgb(248, 81, 73)); }
    }

    private void RenderTasks()
    {
        EnsureCards();
        UpdateSummary();
        var visibleCount = UpdateCardVisibility();
        SetEmptyState(visibleCount == 0);
    }

    private void EnsureCards()
    {
        var ids = tasks.Select(task => task.Id).ToHashSet(StringComparer.Ordinal);
        if (ids.Count == cardsById.Count && ids.SetEquals(cardsById.Keys)) return;

        taskList.SuspendLayout();
        try
        {
            foreach (Control control in taskList.Controls) control.Dispose();
            taskList.Controls.Clear();
            cardsById.Clear();
            cardPartsById.Clear();
            emptyStateLabel = null;
            foreach (var task in tasks)
            {
                var card = CreateCard(task);
                cardsById[task.Id] = card;
                taskList.Controls.Add(card);
            }
            ResizeCards();
        }
        finally { taskList.ResumeLayout(false); }
    }

    private int UpdateCardVisibility()
    {
        var query = searchBox.Text.Trim();
        var filter = statusFilter.SelectedIndex switch { 1 => "needs_review", 2 => "done", 3 => "no_log", 4 => "all", _ => "pending" };
        var visibleIds = GalaxyTaskFilter.Filter(tasks, query, filter).Select(task => task.Id).ToHashSet(StringComparer.Ordinal);
        taskList.SuspendLayout();
        try
        {
            foreach (var task in tasks)
            {
                if (!cardsById.TryGetValue(task.Id, out var card)) continue;
                card.Visible = visibleIds.Contains(task.Id);
            }
        }
        finally { taskList.ResumeLayout(true); }
        return visibleIds.Count;
    }

    private void UpdateSummary()
    {
        var counts = tasks.GroupBy(task => task.Status).ToDictionary(group => group.Key, group => group.Count());
        summaryLabel.Text = $"全部 {tasks.Count} · 未取 {counts.GetValueOrDefault("pending")} · 已取 {counts.GetValueOrDefault("done")} · 沒有當天 Log {counts.GetValueOrDefault("no_log")}";
    }

    private void SetEmptyState(bool visible)
    {
        if (!visible)
        {
            if (emptyStateLabel != null) { taskList.Controls.Remove(emptyStateLabel); emptyStateLabel.Dispose(); emptyStateLabel = null; }
            return;
        }
        emptyStateLabel ??= new Label { AutoSize = false, Width = 365, Height = 80, TextAlign = ContentAlignment.MiddleCenter, ForeColor = Color.FromArgb(139, 148, 158) };
        emptyStateLabel.Text = tasks.Count == 0 ? "尚未有 Galaxy 清單\r\n請先匯入 CSV" : "沒有符合目前搜尋/篩選的任務";
        if (!taskList.Controls.Contains(emptyStateLabel)) taskList.Controls.Add(emptyStateLabel);
    }

    private Panel CreateCard(GalaxyTask task)
    {
        var card = new Panel { Tag = task.Id, Width = GalaxyLayout.CardWidth(taskList.ClientSize.Width, taskList.Padding.Horizontal, SystemInformation.VerticalScrollBarWidth), Height = 154, BackColor = Color.FromArgb(22, 27, 34), Margin = new Padding(0, 0, 0, 10), Padding = new Padding(14) };
        card.Paint += (_, e) =>
        {
            using var pen = new Pen(task.Status == "done" ? Color.FromArgb(63, 185, 80) : task.Status == "no_log" ? Color.FromArgb(210, 153, 34) : Color.FromArgb(56, 139, 253));
            e.Graphics.DrawRectangle(pen, 0, 0, card.Width - 1, card.Height - 1);
        };
        var serial = new Label { AutoSize = true, Font = new Font("Segoe UI", 18F, FontStyle.Bold), ForeColor = Color.FromArgb(88, 166, 255), Location = new Point(14, 10) };
        var full = new Label { AutoSize = true, Font = new Font("Segoe UI", 8F), ForeColor = Color.FromArgb(139, 148, 158), Location = new Point(14, 43) };
        var target = new Label { AutoSize = true, Font = new Font("Segoe UI", 10F), ForeColor = Color.FromArgb(230, 237, 243), Location = new Point(14, 67) };
        var state = new Label { AutoSize = true, Font = new Font("Segoe UI", 9F, FontStyle.Bold), Location = new Point(14, 94) };
        var action = new Button { Width = 105, Height = 28, Location = new Point(130, 118), FlatStyle = FlatStyle.Flat, ForeColor = Color.White };
        action.FlatAppearance.BorderSize = 0; action.Click += (_, _) => ToggleTask(task);
        var noLog = new Button { Width = 105, Height = 28, Location = new Point(244, 118), FlatStyle = FlatStyle.Flat, ForeColor = Color.White, Text = "沒有當天 Log" };
        noLog.FlatAppearance.BorderSize = 0; noLog.Click += (_, _) => MarkNoLog(task);
        cardPartsById[task.Id] = new CardParts { Serial = serial, Full = full, Target = target, State = state, Action = action, NoLog = noLog };
        card.Controls.AddRange(new Control[] { serial, full, target, state, action, noLog });
        UpdateCard(task);
        return card;
    }

    private void ResizeCards()
    {
        var width = GalaxyLayout.CardWidth(taskList.ClientSize.Width, taskList.Padding.Horizontal, SystemInformation.VerticalScrollBarWidth);
        foreach (var card in cardsById.Values)
        {
            card.Width = width;
            if (card.Tag is string id && cardPartsById.TryGetValue(id, out var parts))
            {
                parts.Action.Left = Math.Max(130, card.ClientSize.Width - 235);
                parts.NoLog.Left = Math.Max(244, card.ClientSize.Width - 121);
            }
        }
    }

    private void UpdateCard(GalaxyTask task)
    {
        if (!cardPartsById.TryGetValue(task.Id, out var parts)) return;
        parts.Serial.Text = task.SerialLast4;
        parts.Full.Text = $"完整 SN {task.FullSerial}";
        parts.Target.Text = $"指定 Log 日期  {task.TargetDate.Replace('-', '/')}";
        parts.State.ForeColor = task.Status == "done" ? Color.FromArgb(63, 185, 80) : task.Status == "no_log" ? Color.FromArgb(210, 153, 34) : Color.FromArgb(230, 237, 243);
        parts.State.Text = task.Status == "done" ? $"已取 · {task.CompletedDate.Replace('-', '/')}" : task.Status == "no_log" ? $"日期已檢查無log · {task.CompletedDate.Replace('-', '/')}" : task.Status == "needs_review" ? "需跟進" : "未取";
        parts.Action.BackColor = task.Status == "pending" || task.Status == "needs_review" ? Color.FromArgb(35, 134, 54) : Color.FromArgb(33, 38, 45);
        parts.Action.Text = task.Status == "done" || task.Status == "no_log" ? "改回未取" : "已取 Log";
        parts.NoLog.BackColor = Color.FromArgb(93, 72, 20);
        parts.NoLog.Visible = task.Status != "done" && task.Status != "no_log";
        if (cardsById.TryGetValue(task.Id, out var card)) card.Invalidate();
    }

    private void ToggleTask(GalaxyTask task)
    {
        if (task.Status == "done" || task.Status == "no_log") { task.Status = "pending"; task.CompletedDate = ""; }
        else { task.Status = "done"; task.CompletedDate = DateTime.Now.ToString("yyyy-MM-dd"); }
        SaveState();
        UpdateCard(task);
        UpdateSummary();
        var visibleCount = UpdateCardVisibility();
        SetEmptyState(visibleCount == 0);
    }

    private void MarkNoLog(GalaxyTask task)
    {
        task.Status = "no_log"; task.CompletedDate = DateTime.Now.ToString("yyyy-MM-dd");
        SaveState();
        UpdateCard(task);
        UpdateSummary();
        var visibleCount = UpdateCardVisibility();
        SetEmptyState(visibleCount == 0);
    }

    private void LoadState()
    {
        try { if (!File.Exists(statePath)) return; var state = JsonSerializer.Deserialize<PersistedState>(File.ReadAllText(statePath)); tasks = state?.Tasks ?? new(); modifiedAtUtcTicks = state?.ModifiedAtUtcTicks ?? 0; }
        catch { tasks = new(); modifiedAtUtcTicks = 0; }
    }

    private void SaveState()
    {
        try { Directory.CreateDirectory(Path.GetDirectoryName(statePath)!); File.WriteAllText(statePath, JsonSerializer.Serialize(new PersistedState { Tasks = tasks, ModifiedAtUtcTicks = modifiedAtUtcTicks }), new UTF8Encoding(false)); }
        catch { SetStatus("本機保存失敗，請確認使用者資料夾有寫入權限", Color.FromArgb(248, 81, 73)); }
    }

    private void SetStatus(string message, Color color) { statusLabel.Text = message; statusLabel.ForeColor = color; }
}
