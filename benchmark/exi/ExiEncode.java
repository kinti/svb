import com.siemens.ct.exi.core.EXIFactory;
import com.siemens.ct.exi.core.helpers.DefaultEXIFactory;
import com.siemens.ct.exi.main.api.sax.EXIResult;
import javax.xml.parsers.SAXParser;
import javax.xml.parsers.SAXParserFactory;
import org.xml.sax.InputSource;
import org.xml.sax.XMLReader;

public class ExiEncode {
  public static void main(String[] args) throws Exception {
    EXIFactory factory = DefaultEXIFactory.newInstance();
    java.io.FileOutputStream fos = new java.io.FileOutputStream(args[1]);
    EXIResult result = new EXIResult(factory);
    result.setOutputStream(fos);
    SAXParserFactory spf = SAXParserFactory.newInstance();
    spf.setNamespaceAware(true);
    XMLReader reader = spf.newSAXParser().getXMLReader();
    reader.setContentHandler(result.getHandler());
    reader.parse(new InputSource(new java.io.FileInputStream(args[0])));
    fos.close();
  }
}
