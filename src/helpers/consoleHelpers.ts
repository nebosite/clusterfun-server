import chalk from "chalk";

const pad2 = (n: number) => n.toString().padStart(2,'0');
const pad3 = (n: number) => n.toString().padStart(3,'0');

export class Logger 
{
    // ---------------------------------------------------------------------------------
    // Get now formatted as YYYY/MM/DD HH:MM:SS.fff
    // ---------------------------------------------------------------------------------
    getCurrentDateString()
    {
        var d = new Date();


        return `${d.getUTCFullYear()}`
            + `/${pad2(d.getUTCMonth()+1)}`
            + `/${pad2(d.getUTCDate())}`
            + ` ${pad2(d.getUTCHours())}`
            + `:${pad2(d.getUTCMinutes())}`
            + `:${pad2(d.getUTCSeconds())}`
            + `.${pad3(d.getUTCMilliseconds())}`
    }

    // ---------------------------------------------------------------------------------
    // Log a line prepended with date
    // ---------------------------------------------------------------------------------
    logLine(text: string) {
        console.log(this.getCurrentDateString() + ']  info: ' + text);
    }

    // ---------------------------------------------------------------------------------
    // Log error with prepended date
    // ---------------------------------------------------------------------------------
    logError(text: string)
    {
        console.error(chalk.redBright(this.getCurrentDateString() + '] error: ' + text));
    }

}
