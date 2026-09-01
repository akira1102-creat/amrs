#nullable enable

namespace GalaxyLogOffline;

public partial class MainForm
{
    private System.ComponentModel.IContainer? components;
    private Label titleLabel = null!;
    private Label subtitleLabel = null!;
    private Button importButton = null!;
    private Button exportButton = null!;
    private TextBox searchBox = null!;
    private ComboBox statusFilter = null!;
    private Label summaryLabel = null!;
    private Label statusLabel = null!;
    private FlowLayoutPanel taskList = null!;

    private void InitializeComponent()
    {
        components = new System.ComponentModel.Container();
        titleLabel = new Label(); subtitleLabel = new Label(); importButton = new Button(); exportButton = new Button();
        searchBox = new TextBox(); statusFilter = new ComboBox(); summaryLabel = new Label(); statusLabel = new Label(); taskList = new FlowLayoutPanel();
        SuspendLayout();
        titleLabel.AutoSize = true; titleLabel.Font = new Font("Segoe UI", 21F, FontStyle.Bold); titleLabel.ForeColor = Color.FromArgb(230, 237, 243); titleLabel.Location = new Point(28, 24); titleLabel.Text = "Galaxy 取 Log Offline";
        subtitleLabel.AutoSize = true; subtitleLabel.Font = new Font("Segoe UI", 10F); subtitleLabel.ForeColor = Color.FromArgb(139, 148, 158); subtitleLabel.Location = new Point(31, 64); subtitleLabel.Text = "完全離線使用 · 匯入 CSV 後現場記錄";
        importButton.Location = new Point(31, 102); importButton.Size = new Size(190, 45); importButton.Text = "匯入 CSV"; importButton.UseVisualStyleBackColor = false;
        exportButton.Location = new Point(230, 102); exportButton.Size = new Size(190, 45); exportButton.Text = "匯出 CSV"; exportButton.UseVisualStyleBackColor = false;
        searchBox.Location = new Point(31, 169); searchBox.Size = new Size(389, 34); searchBox.Font = new Font("Segoe UI", 11F); searchBox.PlaceholderText = "搜尋完整 SN 或末四位";
        statusFilter.DropDownStyle = ComboBoxStyle.DropDownList; statusFilter.Location = new Point(31, 213); statusFilter.Size = new Size(389, 34); statusFilter.Font = new Font("Segoe UI", 11F);
        statusFilter.Items.AddRange(new object[] { "未取", "需跟進", "已取", "沒有當天 Log", "全部" }); statusFilter.SelectedIndex = 0;
        summaryLabel.AutoSize = true; summaryLabel.ForeColor = Color.FromArgb(139, 148, 158); summaryLabel.Location = new Point(31, 258); summaryLabel.Text = "尚未匯入 CSV";
        taskList.AutoScroll = true; taskList.FlowDirection = FlowDirection.TopDown; taskList.WrapContents = false; taskList.Location = new Point(31, 291); taskList.Size = new Size(389, 420); taskList.Padding = new Padding(0, 4, 0, 20);
        statusLabel.AutoEllipsis = true; statusLabel.ForeColor = Color.FromArgb(139, 148, 158); statusLabel.Location = new Point(31, 730); statusLabel.Size = new Size(389, 38); statusLabel.Text = "準備就緒";
        AutoScaleDimensions = new SizeF(7F, 15F); AutoScaleMode = AutoScaleMode.Font; BackColor = Color.FromArgb(13, 17, 23); ClientSize = new Size(455, 785); Controls.AddRange(new Control[] { titleLabel, subtitleLabel, importButton, exportButton, searchBox, statusFilter, summaryLabel, taskList, statusLabel }); ForeColor = Color.FromArgb(230, 237, 243); MinimumSize = new Size(470, 600); StartPosition = FormStartPosition.CenterScreen; Text = "Galaxy 取 Log Offline";
        ResumeLayout(false); PerformLayout();
    }
}
